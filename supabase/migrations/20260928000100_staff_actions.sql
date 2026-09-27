-- Smart Group Tab — staff actions (D2, D17).
--
-- The kitchen screen already said which tables needed a human and why. Nothing
-- let that human do anything about it, so a flagged table stayed flagged and
-- the money behind it was never accounted for. Every action here:
--
--   * takes the same locks as the payment path and re-checks its preconditions
--     under them, so it can lose a race to a payment but never corrupt one;
--   * answers {status, reason} like every other RPC, so a refusal is ordinary;
--   * writes one row to staff_action_log inside its own transaction;
--   * ends by re-evaluating the table's alert.
--
-- Lock order: round, then session — the order confirm_webhook already takes
-- when it credits a late payment. Taking them the other way round here would
-- let a staff action and a webhook deadlock each other.

-- ---------------------------------------------------------------------------
-- The action log. Insert-only: nothing here updates or deletes it.
-- ---------------------------------------------------------------------------
create table staff_action_log (
  id         uuid primary key default gen_random_uuid(),
  action     text not null,
  target_id  uuid not null,
  session_id uuid references sessions (id) on delete set null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index staff_action_log_session_idx on staff_action_log (session_id, created_at);

create or replace function staff_log(p_action text, p_target uuid, p_session uuid, p_detail jsonb)
returns void
language sql
as $$
  insert into staff_action_log (action, target_id, session_id, detail)
  values (p_action, p_target, p_session, coalesce(p_detail, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- I2's transition, in one place. confirm_webhook released a round from inside
-- its own body; resuming a stalled round needs the very same step, and two
-- copies of the thing that fires the kitchen is one too many. Caller holds the
-- round lock. Returns whether this call is the one that released it.
-- ---------------------------------------------------------------------------
create or replace function release_round_if_settled(p_round_id uuid)
returns boolean
language plpgsql
as $$
declare
  v_transitioned integer;
begin
  if not round_is_fully_settled(p_round_id) then
    return false;
  end if;

  update rounds
     set status = 'paid_and_dispatched', dispatched_at = now()
   where id = p_round_id
     and status = 'locked_for_payment';

  get diagnostics v_transitioned = row_count;

  if v_transitioned = 1 then
    insert into dispatches (round_id, channel)
    values (p_round_id, 'kds'), (p_round_id, 'print')
        on conflict (round_id, channel) do nothing;
  end if;

  return v_transitioned = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_webhook: the body from 20260920000100 with two changes only —
-- money for a cancelled round is credited (never applied), and the release to
-- the kitchen goes through release_round_if_settled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_webhook(p_provider text, p_event_id text, p_psp_reference text, p_outcome text, p_amount bigint, p_payload jsonb DEFAULT '{}'::jsonb, p_signature_verified boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_event_id        uuid;
  v_res             contribution_reservations;
  v_round           rounds;
  v_expected        bigint;
  v_received        bigint;
  v_shares_taken    boolean;
  v_contribution_id uuid;
  v_transitioned    integer;
  v_approved        boolean;
  v_round_cancelled boolean;
begin
  v_approved := p_outcome is not distinct from 'approved';

  insert into webhook_events (provider, event_id, payload, signature_verified)
  values (p_provider, p_event_id, coalesce(p_payload, '{}'::jsonb),
          coalesce(p_signature_verified, false))
      on conflict (provider, event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return jsonb_build_object('status', 'duplicate_event', 'event_id', p_event_id);
  end if;

  select * into v_res
    from contribution_reservations
   where psp_reference = p_psp_reference;

  if not found then
    -- An approval we cannot place stays unprocessed on purpose: that is the
    -- queue a human works from. A decline needs no follow-up.
    if not v_approved then
      update webhook_events set processed_at = now() where id = v_event_id;
    end if;
    return jsonb_build_object('status', 'unknown_reference', 'event_id', p_event_id);
  end if;

  v_round := lock_round(v_res.round_id);
  select * into v_res from contribution_reservations where id = v_res.id;

  v_expected := v_res.order_amount + v_res.tip_amount;
  v_received := coalesce(p_amount, v_expected);

  if v_received <= 0 and v_approved then
    -- An approval for nothing is a disagreement, not a payment. Recorded rather
    -- than raised: raising would roll back the idempotency row and Wompi would
    -- retry the same failure forever.
    update webhook_events set processed_at = now() where id = v_event_id;
    return jsonb_build_object(
      'status', 'rejected', 'reason', 'non_positive_amount', 'reservation_id', v_res.id);
  end if;

  if v_res.status = 'confirmed' then
    if not v_approved then
      update webhook_events set processed_at = now() where id = v_event_id;
      return jsonb_build_object('status', 'already_settled', 'reservation_id', v_res.id);
    end if;

    -- A second genuine payment for one reservation: the diner had the checkout
    -- open twice. Both moved money, so both are recorded; the duplicate becomes
    -- table credit and a human sorts it out (D2).
    insert into contributions
      (reservation_id, round_id, session_id, participant_id,
       order_amount, tip_amount, webhook_event_id, applied_to_prepaid_balance)
    values (v_res.id, v_res.round_id, v_round.session_id, v_res.participant_id,
            v_received, 0, v_event_id, true)
    returning id into v_contribution_id;

    update sessions
       set prepaid_balance = prepaid_balance + v_received,
           status = case when status = 'closed' then status else 'requires_staff_attention' end
     where id = v_round.session_id;

    update webhook_events set processed_at = now() where id = v_event_id;

    return jsonb_build_object(
      'status',          'credited',
      'reason',          'duplicate_payment',
      'contribution_id', v_contribution_id,
      'reservation_id',  v_res.id,
      'credited_amount', v_received);
  end if;

  if not v_approved then
    update contribution_reservations
       set status = 'cancelled', settled_at = now()
     where id = v_res.id and status = 'active';

    update webhook_events set processed_at = now() where id = v_event_id;
    return jsonb_build_object(
      'status', 'released', 'reservation_id', v_res.id, 'outcome', p_outcome);
  end if;

  -- A round staff cancelled (D2) cannot take money any more: whatever arrives
  -- for it is credited to the table and flagged, exactly like a late payment.
  -- It stays cancelled; nothing goes to the kitchen.
  v_round_cancelled := v_round.status = 'cancelled';

  select exists (
    select 1
      from reservation_allocations mine
     where mine.reservation_id = v_res.id
       and exists (
         select 1
           from reservation_allocations other
           join contribution_reservations r2 on r2.id = other.reservation_id
          where other.cart_item_share_id = mine.cart_item_share_id
            and other.reservation_id <> v_res.id
            and (r2.status = 'confirmed'
                 or (r2.status = 'active' and r2.expires_at > now()))))
  into v_shares_taken;

  if v_round_cancelled or v_shares_taken or v_received is distinct from v_expected then
    insert into contributions
      (reservation_id, round_id, session_id, participant_id,
       order_amount, tip_amount, webhook_event_id, applied_to_prepaid_balance)
    values (v_res.id, v_res.round_id, v_round.session_id, v_res.participant_id,
            v_received, 0, v_event_id, true)
    returning id into v_contribution_id;

    update contribution_reservations
       set status = 'cancelled', settled_at = now()
     where id = v_res.id;

    update sessions
       set prepaid_balance = prepaid_balance + v_received,
           status = case when status = 'closed' then status else 'requires_staff_attention' end
     where id = v_round.session_id;

    update rounds
       set status = 'requires_staff_attention'
     where id = v_round.id
       and status = 'locked_for_payment';

    update webhook_events set processed_at = now() where id = v_event_id;

    return jsonb_build_object(
      'status',          'credited',
      'reason',          case when v_round_cancelled then 'round_cancelled'
                              when v_shares_taken then 'shares_retaken'
                              else 'amount_mismatch' end,
      'contribution_id', v_contribution_id,
      'reservation_id',  v_res.id,
      'credited_amount', v_received,
      'expected_amount', v_expected);
  end if;

  insert into contributions
    (reservation_id, round_id, session_id, participant_id,
     order_amount, tip_amount, webhook_event_id, applied_to_prepaid_balance)
  values (v_res.id, v_res.round_id, v_round.session_id, v_res.participant_id,
          v_res.order_amount, v_res.tip_amount, v_event_id, false)
  returning id into v_contribution_id;

  update contribution_reservations
     set status = 'confirmed', settled_at = now()
   where id = v_res.id;

  v_transitioned := case when release_round_if_settled(v_round.id) then 1 else 0 end;

  update webhook_events set processed_at = now() where id = v_event_id;

  return jsonb_build_object(
    'status',          'settled',
    'contribution_id', v_contribution_id,
    'reservation_id',  v_res.id,
    'round_settled',   round_is_fully_settled(v_round.id),
    'dispatched',      coalesce(v_transitioned, 0) = 1);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Alert reasons, now aware of what staff did about them.
--
--   money not placed   until completed refunds cover the credited amount; the
--                      refunds recorded so far travel with it.
--   collection stalled every round in requires_staff_attention. It used to
--                      exclude rounds holding credit, which after a refund left
--                      a flagged round with no reason at all.
-- ---------------------------------------------------------------------------
create or replace function staff_alert_reasons(p_session_id uuid)
returns jsonb
language sql
stable
as $$
  with money as (
    select c.id, c.order_amount + c.tip_amount as amount,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', f.id, 'kind', f.kind, 'amount', f.amount, 'status', f.status)
                   order by f.created_at), '[]'::jsonb)
              from refunds f
             where f.contribution_id = c.id and f.status <> 'rejected') as refunds
      from contributions c
     where c.session_id = p_session_id
       and c.applied_to_prepaid_balance
       and (select coalesce(sum(f.amount), 0) from refunds f
             where f.contribution_id = c.id and f.status = 'completed')
           < c.order_amount + c.tip_amount
  ),
  failed as (
    select d.id, d.channel, d.last_error, r.round_number
      from dispatches d
      join rounds r on r.id = d.round_id
     where r.session_id = p_session_id
       and d.status = 'failed'
  ),
  stalled as (
    select r.id, r.round_number
      from rounds r
     where r.session_id = p_session_id
       and r.status = 'requires_staff_attention'
  ),
  reasons as (
    select 'contribution:' || id as key, jsonb_build_object(
             'kind', 'money_not_placed', 'contribution_id', id, 'amount', amount,
             'refunds', refunds) as reason
      from money
    union all
    select 'dispatch:' || id, jsonb_build_object(
             'kind', 'delivery_failed', 'dispatch_id', id, 'channel', channel,
             'round_number', round_number, 'error', last_error)
      from failed
    union all
    select 'round:' || id, jsonb_build_object(
             'kind', 'collection_stalled', 'round_id', id, 'round_number', round_number)
      from stalled
  )
  select coalesce(
           jsonb_agg(reason || jsonb_build_object('key', key) order by key),
           -- An alert that cannot explain itself is still an alert.
           jsonb_build_array(jsonb_build_object('kind', 'unknown', 'key', 'unknown')))
    from reasons;
$$;

-- Same shape as before, plus the table's prepaid balance: a refund cannot take
-- more than is there, and the screen shows it before staff try.
create or replace function staff_alerts(p_stall interval)
returns jsonb
language sql
stable
as $$
  with alerting as (
    select s.id, t.label, s.prepaid_balance, staff_alert_reasons(s.id) as reasons
      from sessions s
      join tables t on t.id = s.table_id
     where s.status = 'requires_staff_attention'
  )
  select jsonb_build_object(
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object(
               'session_id', a.id,
               'table', a.label,
               'prepaid_balance', a.prepaid_balance,
               'reasons', a.reasons,
               'acknowledged_at',
                 case when ack.reason_keys @> array(
                        select r ->> 'key' from jsonb_array_elements(a.reasons) r)
                      then ack.acknowledged_at end)
             order by a.label)
        from alerting a
        left join staff_alert_acks ack on ack.session_id = a.id), '[]'::jsonb),
    'stalled_dispatches', (
      select jsonb_build_object(
               'count', count(*),
               'oldest_seconds', coalesce(
                 extract(epoch from now() - min(d.next_attempt_at))::int, 0))
        from dispatches d
       where d.status = 'pending'
         and d.next_attempt_at < now() - p_stall)
  );
$$;

/**
 * A table whose every reason is resolved goes back to `open`. Only real
 * reasons count: the `unknown` placeholder is what an empty list looks like.
 */
create or replace function staff_resolve_if_clear(p_session_id uuid)
returns boolean
language plpgsql
as $$
declare
  v_cleared integer;
begin
  update sessions
     set status = 'open'
   where id = p_session_id
     and status = 'requires_staff_attention'
     and not exists (
       select 1 from jsonb_array_elements(staff_alert_reasons(p_session_id)) r
        where r ->> 'kind' <> 'unknown');
  get diagnostics v_cleared = row_count;
  return v_cleared = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rounds still collecting, with who is holding what — for "Cobros abiertos".
-- Nicknames and amounts only: no references, no payment ids.
-- ---------------------------------------------------------------------------
create or replace function staff_collections()
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'round_id',     r.id,
           'session_id',   r.session_id,
           'table',        t.label,
           'round_number', r.round_number,
           'status',       r.status,
           'total',        round_total(r.id),
           -- Not yet paid, held or not: what staff mean by "what's missing".
           -- round_outstanding() is narrower — only what nobody holds.
           'outstanding',  (select coalesce(sum(a.owed_amount), 0)
                              from active_shares(r.id) a
                             where not is_share_settled(a.id)),
           'unclaimed',    round_outstanding(r.id),
           'reservations', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'id',         cr.id,
                      'nickname',   p.nickname,
                      'amount',     cr.order_amount + cr.tip_amount,
                      'expires_at', cr.expires_at)
                    order by cr.expires_at), '[]'::jsonb)
               from contribution_reservations cr
               join participants p on p.id = cr.participant_id
              where cr.round_id = r.id
                and cr.status = 'active'
                and cr.expires_at > now()))
         order by t.label, r.round_number), '[]'::jsonb)
    from rounds r
    join sessions s on s.id = r.session_id
    join tables t on t.id = s.table_id
   where r.status in ('locked_for_payment', 'requires_staff_attention');
$$;

-- ---------------------------------------------------------------------------
-- Refunds (refund-registry). Only against credited money, and they move the
-- balance: recording takes the amount out so it cannot also be spent;
-- rejecting puts it back; completing changes nothing further.
-- ---------------------------------------------------------------------------
create or replace function staff_record_refund(
  p_contribution_id    uuid,
  p_kind               text,
  p_amount             bigint,
  p_reason             text,
  p_external_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contribution contributions;
  v_session      sessions;
  v_committed    bigint;
  v_refund_id    uuid;
begin
  select * into v_contribution from contributions where id = p_contribution_id;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_contribution');
  end if;

  -- The balance lives on the session: this lock is what stops two refunds
  -- against one credit from both passing the ceiling.
  select * into v_session from sessions where id = v_contribution.session_id for update;

  if not v_contribution.applied_to_prepaid_balance then
    return jsonb_build_object('status', 'rejected', 'reason', 'not_credited');
  end if;
  if p_kind is null or p_kind not in ('reversed', 'refunded') then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_kind');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_amount');
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'reason_required');
  end if;

  select coalesce(sum(amount), 0) into v_committed
    from refunds
   where contribution_id = p_contribution_id and status <> 'rejected';

  if v_committed + p_amount > v_contribution.order_amount + v_contribution.tip_amount then
    return jsonb_build_object('status', 'rejected', 'reason', 'exceeds_payment');
  end if;
  if p_amount > v_session.prepaid_balance then
    return jsonb_build_object('status', 'rejected', 'reason', 'exceeds_balance',
                              'prepaid_balance', v_session.prepaid_balance);
  end if;

  insert into refunds (contribution_id, amount, reason, kind, external_reference)
  values (p_contribution_id, p_amount, btrim(p_reason), p_kind::refund_kind,
          nullif(btrim(coalesce(p_external_reference, '')), ''))
  returning id into v_refund_id;

  update sessions set prepaid_balance = prepaid_balance - p_amount where id = v_session.id;

  perform staff_log('record_refund', v_refund_id, v_session.id, jsonb_build_object(
    'contribution_id', p_contribution_id, 'kind', p_kind, 'amount', p_amount,
    'reason', btrim(p_reason)));

  return jsonb_build_object('status', 'recorded', 'refund_id', v_refund_id);
end;
$$;

create or replace function staff_set_refund_status(p_refund_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund     refunds;
  v_session_id uuid;
begin
  select c.session_id into v_session_id
    from refunds f join contributions c on c.id = f.contribution_id
   where f.id = p_refund_id;
  if v_session_id is null then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_refund');
  end if;

  perform 1 from sessions where id = v_session_id for update;
  select * into v_refund from refunds where id = p_refund_id;

  if p_status is null or p_status not in ('completed', 'rejected') then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_status');
  end if;
  if v_refund.status <> 'pending' then
    return jsonb_build_object('status', 'rejected', 'reason', 'refund_not_pending');
  end if;

  update refunds
     set status = p_status::refund_status,
         completed_at = case when p_status = 'completed' then now() end
   where id = p_refund_id;

  -- The money never left, so the table can use it again.
  if p_status = 'rejected' then
    update sessions set prepaid_balance = prepaid_balance + v_refund.amount where id = v_session_id;
  end if;

  perform staff_log('set_refund_status', p_refund_id, v_session_id,
                    jsonb_build_object('status', p_status, 'amount', v_refund.amount));
  perform staff_resolve_if_clear(v_session_id);

  return jsonb_build_object('status', p_status, 'refund_id', p_refund_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Rounds.
-- ---------------------------------------------------------------------------

/** Cancel a round nobody has paid for. Credit already on the round does not block. */
create or replace function staff_cancel_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_round    rounds;
  v_released integer;
begin
  if not exists (select 1 from rounds where id = p_round_id) then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_round');
  end if;
  v_round := lock_round(p_round_id);

  if v_round.status not in ('locked_for_payment', 'requires_staff_attention') then
    return jsonb_build_object('status', 'rejected', 'reason', 'round_not_cancellable',
                              'round_status', v_round.status);
  end if;
  if exists (select 1 from contributions
              where round_id = p_round_id and not applied_to_prepaid_balance) then
    return jsonb_build_object('status', 'rejected', 'reason', 'round_has_payments');
  end if;

  update rounds set status = 'cancelled' where id = p_round_id;

  update contribution_reservations
     set status = 'cancelled', settled_at = now()
   where round_id = p_round_id and status = 'active';
  get diagnostics v_released = row_count;

  perform staff_log('cancel_round', p_round_id, v_round.session_id,
                    jsonb_build_object('round_number', v_round.round_number,
                                       'released_reservations', v_released));
  perform staff_resolve_if_clear(v_round.session_id);

  return jsonb_build_object('status', 'cancelled', 'round_id', p_round_id,
                            'released_reservations', v_released);
end;
$$;

/**
 * Back to collecting. Payments that landed while the round was flagged could
 * not release it — confirm_webhook only releases from locked_for_payment — so
 * the release check runs here too.
 */
create or replace function staff_resume_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_round      rounds;
  v_dispatched boolean;
begin
  if not exists (select 1 from rounds where id = p_round_id) then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_round');
  end if;
  v_round := lock_round(p_round_id);

  if v_round.status <> 'requires_staff_attention' then
    return jsonb_build_object('status', 'rejected', 'reason', 'round_not_stalled',
                              'round_status', v_round.status);
  end if;

  update rounds set status = 'locked_for_payment' where id = p_round_id;
  v_dispatched := release_round_if_settled(p_round_id);

  perform staff_log('resume_round', p_round_id, v_round.session_id,
                    jsonb_build_object('round_number', v_round.round_number,
                                       'dispatched', v_dispatched));
  perform staff_resolve_if_clear(v_round.session_id);

  return jsonb_build_object('status', 'resumed', 'round_id', p_round_id,
                            'dispatched', v_dispatched);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reservations and dispatches.
-- ---------------------------------------------------------------------------
create or replace function staff_release_reservation(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res   contribution_reservations;
  v_round rounds;
begin
  select * into v_res from contribution_reservations where id = p_reservation_id;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_reservation');
  end if;

  v_round := lock_round(v_res.round_id);
  select * into v_res from contribution_reservations where id = p_reservation_id;

  if v_res.status <> 'active' or v_res.expires_at <= now() then
    return jsonb_build_object('status', 'rejected', 'reason', 'reservation_not_live');
  end if;

  update contribution_reservations
     set status = 'cancelled', settled_at = now()
   where id = p_reservation_id;

  perform staff_log('release_reservation', p_reservation_id, v_round.session_id,
                    jsonb_build_object('round_id', v_round.id,
                                       'amount', v_res.order_amount + v_res.tip_amount));

  return jsonb_build_object('status', 'released', 'reservation_id', p_reservation_id);
end;
$$;

create or replace function staff_retry_dispatch(p_dispatch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dispatch dispatches;
  v_session  uuid;
begin
  select * into v_dispatch from dispatches where id = p_dispatch_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_dispatch');
  end if;
  if v_dispatch.status <> 'failed' then
    return jsonb_build_object('status', 'rejected', 'reason', 'dispatch_not_failed',
                              'dispatch_status', v_dispatch.status);
  end if;

  -- A fresh budget: the worker's bounded attempts apply again from zero.
  update dispatches
     set status = 'pending', attempts = 0, next_attempt_at = now()
   where id = p_dispatch_id;

  select session_id into v_session from rounds where id = v_dispatch.round_id;
  perform staff_log('retry_dispatch', p_dispatch_id, v_session,
                    jsonb_build_object('channel', v_dispatch.channel,
                                       'previous_error', v_dispatch.last_error));
  perform staff_resolve_if_clear(v_session);

  return jsonb_build_object('status', 'retrying', 'dispatch_id', p_dispatch_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The periodic Wompi check (20260927000100) stopped at any cancelled
-- reservation. Staff can now cancel one while its diner is still inside the
-- checkout, and that diner can still pay until the checkout expires with the
-- hold. Keep asking until a little after that, or a payment whose webhook is
-- lost would be invisible again.
-- ---------------------------------------------------------------------------
create or replace function claim_due_checkouts(
  p_interval interval,
  p_window   interval default interval '24 hours',
  p_limit    integer  default 50
)
returns table (reservation_id uuid, psp_reference text)
language sql
as $$
  with due as (
    select rc.reservation_id
      from reservation_checkouts rc
      join contribution_reservations r on r.id = rc.reservation_id
     where rc.next_check_at <= now()
       and rc.first_issued_at > now() - p_window
       and (r.status in ('active', 'expired')
            -- Cancelled by staff, not by Wompi: a decline is a final answer,
            -- a staff cancel is not.
            or (r.status = 'cancelled'
                and r.expires_at > now() - interval '10 minutes'
                and (exists (select 1 from rounds ro
                              where ro.id = r.round_id and ro.status = 'cancelled')
                     or exists (select 1 from staff_action_log l
                                 where l.action = 'release_reservation'
                                   and l.target_id = r.id))))
     order by rc.next_check_at
     limit p_limit
       for update of rc skip locked
  )
  update reservation_checkouts rc
     set next_check_at = now() + p_interval,
         check_count   = rc.check_count + 1
    from due, contribution_reservations r
   where rc.reservation_id = due.reservation_id
     and r.id = rc.reservation_id
  returning rc.reservation_id, r.psp_reference;
$$;

-- ---------------------------------------------------------------------------
-- Grants: staff actions are reached only through the KDS server's own
-- connection, never by a client.
-- ---------------------------------------------------------------------------
alter table staff_action_log enable row level security;
revoke all on staff_action_log from public, anon, authenticated;

revoke all on function
  confirm_webhook(text, text, text, text, bigint, jsonb, boolean),
  staff_log(text, uuid, uuid, jsonb),
  release_round_if_settled(uuid),
  staff_alert_reasons(uuid),
  staff_alerts(interval),
  staff_resolve_if_clear(uuid),
  staff_collections(),
  staff_record_refund(uuid, text, bigint, text, text),
  staff_set_refund_status(uuid, text),
  staff_cancel_round(uuid),
  staff_resume_round(uuid),
  staff_release_reservation(uuid),
  staff_retry_dispatch(uuid),
  claim_due_checkouts(interval, interval, integer)
from public, anon, authenticated;
