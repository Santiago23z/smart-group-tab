-- Smart Group Tab — closing a table (option 3).
--
-- An open tab had no ending: open_tab rounds reach the kitchen unpaid, and a
-- reservation only accepts a round still in collection, so the tab could not
-- be paid at all and the session never closed. §15 is answered — the table
-- absorbs an unpaid share; a whole-table walkout is a venue write-off — and
-- this migration builds the ending:
--
--   * a reservation (and its contribution) may belong to a session rather
--     than one round, so one checkout pays a diner's whole tab;
--   * asking for the bill is recorded apart from the session's status;
--   * hybrid rounds paid from the prepaid balance are recorded as paid;
--   * write-offs are recorded share by share;
--   * a session closes when nothing is left open.

-- ---------------------------------------------------------------------------
-- 1. Reservations and contributions that belong to a session, not a round.
-- ---------------------------------------------------------------------------
alter table contribution_reservations
  add column session_id uuid references sessions (id) on delete restrict;

update contribution_reservations r
   set session_id = rd.session_id
  from rounds rd
 where rd.id = r.round_id;

-- The backfill queued the table's deferred integrity checks; run them now, or
-- the ALTERs below refuse to touch a table with pending trigger events.
set constraints all immediate;

alter table contribution_reservations alter column session_id set not null;
alter table contribution_reservations alter column round_id drop not null;
alter table contributions alter column round_id drop not null;

create index contribution_reservations_session_idx
  on contribution_reservations (session_id, status);

-- Round reservations keep being created by reserve_contribution, which knows
-- nothing about session_id. Filling it here keeps that function untouched.
create or replace function tg_reservation_session()
returns trigger
language plpgsql
as $$
begin
  if new.session_id is null then
    select session_id into new.session_id from rounds where id = new.round_id;
  end if;
  return new;
end;
$$;

create trigger contribution_reservations_session
  before insert on contribution_reservations
  for each row execute function tg_reservation_session();

-- ---------------------------------------------------------------------------
-- 2. Settlement marker, and rounds paid from the balance.
-- ---------------------------------------------------------------------------
-- Apart from `status` on purpose: a table paying its bill can also need staff
-- (a late payment credited), and one enum cannot say both.
alter table sessions add column bill_requested_at timestamptz;

-- A hybrid round 2+ that the prepaid balance covered went to the kitchen with
-- no contribution. Without this flag the tab would charge it again.
alter table rounds add column paid_from_balance boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3. Write-offs: a departed table's tab, recorded share by share.
-- ---------------------------------------------------------------------------
create table write_offs (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions (id) on delete restrict,
  amount     money_amount not null check (amount > 0),
  reason     text not null check (length(btrim(reason)) > 0),
  created_at timestamptz not null default now()
);

create table write_off_shares (
  write_off_id       uuid not null references write_offs (id) on delete restrict,
  cart_item_share_id uuid not null unique references cart_item_shares (id) on delete restrict,
  amount             money_amount not null check (amount > 0),
  primary key (write_off_id, cart_item_share_id)
);

create trigger write_offs_append_only
  before update or delete on write_offs
  for each row execute function tg_forbid_mutation();
create trigger write_off_shares_append_only
  before update or delete on write_off_shares
  for each row execute function tg_forbid_mutation();

alter table write_offs enable row level security;
alter table write_off_shares enable row level security;
revoke all on write_offs, write_off_shares from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The tab: what went to the kitchen and was never paid.
--
-- Rounds collected before the kitchen have settled shares and fall out on
-- their own; requires_prepayment is defence in depth. Hybrid rounds the
-- balance paid are excluded by their flag.
-- ---------------------------------------------------------------------------
create or replace function session_tab_shares(p_session_id uuid)
returns setof cart_item_shares
language sql
stable
as $$
  select s.*
    from cart_item_shares s
    join cart_items ci on ci.id = s.cart_item_id and ci.status = 'active'
    join rounds r on r.id = s.round_id
   where r.session_id = p_session_id
     and r.status = 'paid_and_dispatched'
     and not r.requires_prepayment
     and not r.paid_from_balance
     and not is_share_settled(s.id)
     and not exists (select 1 from write_off_shares w where w.cart_item_share_id = s.id)
   order by s.owed_amount, s.created_at, s.id;
$$;

create or replace function tab_summary(p_session_id uuid)
returns jsonb
language sql
stable
as $$
  with tab as (select * from session_tab_shares(p_session_id))
  select jsonb_build_object(
    'total', (select coalesce(sum(owed_amount), 0) from tab),
    'held',  (select coalesce(sum(owed_amount), 0) from tab where is_share_held(tab.id)),
    'participants', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'participant_id', p.id,
               'nickname',       p.nickname,
               'unpaid',         x.unpaid,
               'held',           x.held)
             order by p.joined_at), '[]'::jsonb)
        from (select participant_id, sum(owed_amount) as unpaid,
                     coalesce(sum(owed_amount) filter (where is_share_held(tab.id)), 0) as held
                from tab group by participant_id) x
        join participants p on p.id = x.participant_id));
$$;

-- ---------------------------------------------------------------------------
-- 5. Closing. Every condition that keeps a table open, by name.
-- ---------------------------------------------------------------------------
create or replace function session_close_blockers(p_session_id uuid)
returns text[]
language sql
stable
as $$
  select array_remove(array[
    case when s.bill_requested_at is null then 'bill_not_requested' end,
    case when exists (select 1 from session_tab_shares(s.id)) then 'tab_unpaid' end,
    case when exists (select 1 from rounds r where r.session_id = s.id
                       and r.status in ('locked_for_payment', 'requires_staff_attention'))
         then 'round_in_collection' end,
    case when s.prepaid_balance > 0 then 'balance_left' end,
    case when exists (select 1 from refunds f join contributions c on c.id = f.contribution_id
                       where c.session_id = s.id and f.status = 'pending')
         then 'refund_pending' end,
    -- A failed delivery, say: closing would make the alert vanish unresolved.
    case when s.status = 'requires_staff_attention' then 'alert_open' end
  ], null)
    from sessions s
   where s.id = p_session_id;
$$;

/** Closes the session if nothing blocks it. Caller holds no lock it could invert: session last. */
create or replace function try_close_session(p_session_id uuid)
returns boolean
language plpgsql
as $$
declare
  v_closed integer;
begin
  update sessions
     set status = 'closed', closed_at = now()
   where id = p_session_id
     and status <> 'closed'
     and cardinality(session_close_blockers(p_session_id)) = 0;
  get diagnostics v_closed = row_count;
  return v_closed = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Asking for the bill.
-- ---------------------------------------------------------------------------
create or replace function request_bill_core(p_session_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_session sessions;
begin
  select * into v_session from sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_session');
  end if;
  if v_session.status = 'closed' then
    return jsonb_build_object('status', 'rejected', 'reason', 'session_closed');
  end if;
  if v_session.bill_requested_at is not null then
    return jsonb_build_object('status', 'requested', 'already', true);
  end if;

  -- Items never sent to the kitchen: send them or remove them first.
  if exists (select 1 from rounds r join cart_items ci on ci.round_id = r.id
              where r.session_id = p_session_id and r.status = 'draft' and ci.status = 'active') then
    return jsonb_build_object('status', 'rejected', 'reason', 'draft_not_empty');
  end if;

  update sessions
     set bill_requested_at = now(),
         status = case when status = 'open' then 'settling' else status end
   where id = p_session_id;

  return jsonb_build_object('status', 'requested', 'already', false,
                            'closed', try_close_session(p_session_id));
end;
$$;

create or replace function request_bill(p_session_id uuid, p_participant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := current_participant_id();
begin
  if v_caller is not null and v_caller <> p_participant_id then
    raise exception using errcode = 'insufficient_privilege',
      message = 'cannot ask for the bill on behalf of another participant';
  end if;
  if not exists (select 1 from participants where id = p_participant_id and session_id = p_session_id) then
    return jsonb_build_object('status', 'rejected', 'reason', 'participant_not_in_session');
  end if;
  return request_bill_core(p_session_id);
end;
$$;

create or replace function staff_request_bill(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb := request_bill_core(p_session_id);
begin
  if v_result ->> 'status' = 'requested' and not (v_result ->> 'already')::boolean then
    perform staff_log('request_bill', p_session_id, p_session_id, '{}'::jsonb);
  end if;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Reserving the tab: one reservation across every round, held exactly like
-- a round reservation. Serialized on the session: tab shares belong to rounds
-- already sent to the kitchen, which reserve_contribution refuses, so round
-- and tab reservations never compete for a share.
-- ---------------------------------------------------------------------------
create or replace function reserve_tab(
  p_session_id      uuid,
  p_participant_id  uuid,
  p_mode            text,
  p_idempotency_key text,
  p_tip_amount      bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller      uuid := current_participant_id();
  v_session     sessions;
  v_existing    contribution_reservations;
  v_target      uuid[];
  v_total       bigint;
  v_reservation contribution_reservations;
begin
  if v_caller is not null and v_caller <> p_participant_id then
    raise exception using errcode = 'insufficient_privilege',
      message = 'cannot reserve on behalf of another participant';
  end if;

  select * into v_session from sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_session');
  end if;

  select * into v_existing from contribution_reservations where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'status', 'duplicate', 'reservation_id', v_existing.id,
      'psp_reference', v_existing.psp_reference, 'order_amount', v_existing.order_amount,
      'tip_amount', v_existing.tip_amount, 'expires_at', v_existing.expires_at);
  end if;

  if v_session.status = 'closed' then
    return jsonb_build_object('status', 'rejected', 'reason', 'session_closed');
  end if;
  if v_session.bill_requested_at is null then
    return jsonb_build_object('status', 'rejected', 'reason', 'bill_not_requested');
  end if;
  if not exists (select 1 from participants where id = p_participant_id and session_id = p_session_id) then
    return jsonb_build_object('status', 'rejected', 'reason', 'participant_not_in_session');
  end if;
  if p_mode not in ('my_items', 'remaining') then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_mode');
  end if;
  if coalesce(p_tip_amount, 0) < 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_tip');
  end if;

  select coalesce(array_agg(t.id), '{}'), coalesce(sum(t.owed_amount), 0)
    into v_target, v_total
    from session_tab_shares(p_session_id) t
   where not is_share_held(t.id)
     and (p_mode = 'remaining' or t.participant_id = p_participant_id);

  if cardinality(v_target) = 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'nothing_available');
  end if;

  insert into contribution_reservations
    (round_id, session_id, participant_id, order_amount, tip_amount,
     idempotency_key, psp_reference, expires_at)
  values (null, p_session_id, p_participant_id, v_total, coalesce(p_tip_amount, 0),
          p_idempotency_key, 'sgt-' || replace(gen_random_uuid()::text, '-', ''),
          now() + v_session.reservation_ttl)
  returning * into v_reservation;

  insert into reservation_allocations (reservation_id, cart_item_share_id, amount)
  select v_reservation.id, s.id, s.owed_amount
    from cart_item_shares s
   where s.id = any(v_target);

  return jsonb_build_object(
    'status', 'reserved', 'reservation_id', v_reservation.id,
    'psp_reference', v_reservation.psp_reference, 'order_amount', v_reservation.order_amount,
    'tip_amount', v_reservation.tip_amount, 'expires_at', v_reservation.expires_at,
    'share_ids', to_jsonb(v_target));
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Settling a tab payment. The round path of confirm_webhook, rule for rule,
-- under the session lock. Reached only from confirm_webhook, after its
-- idempotency gate.
-- ---------------------------------------------------------------------------
create or replace function confirm_tab_payment(
  p_event_id       uuid,
  p_reservation_id uuid,
  p_amount         bigint,
  p_approved       boolean
)
returns jsonb
language plpgsql
as $$
declare
  v_res             contribution_reservations;
  v_expected        bigint;
  v_received        bigint;
  v_unplaceable     boolean;
  v_contribution_id uuid;
begin
  select * into v_res from contribution_reservations where id = p_reservation_id;
  perform 1 from sessions where id = v_res.session_id for update;
  select * into v_res from contribution_reservations where id = p_reservation_id;

  v_expected := v_res.order_amount + v_res.tip_amount;
  v_received := coalesce(p_amount, v_expected);

  if v_received <= 0 and p_approved then
    update webhook_events set processed_at = now() where id = p_event_id;
    return jsonb_build_object('status', 'rejected', 'reason', 'non_positive_amount',
                              'reservation_id', v_res.id);
  end if;

  if v_res.status = 'confirmed' then
    if not p_approved then
      update webhook_events set processed_at = now() where id = p_event_id;
      return jsonb_build_object('status', 'already_settled', 'reservation_id', v_res.id);
    end if;
    v_unplaceable := true;  -- a second payment for one reservation
  elsif not p_approved then
    update contribution_reservations set status = 'cancelled', settled_at = now()
     where id = v_res.id and status = 'active';
    update webhook_events set processed_at = now() where id = p_event_id;
    return jsonb_build_object('status', 'released', 'reservation_id', v_res.id);
  else
    -- Retaken by someone else, written off by staff, or not the amount held.
    select exists (
             select 1 from reservation_allocations mine
              where mine.reservation_id = v_res.id
                and (exists (select 1 from write_off_shares w
                              where w.cart_item_share_id = mine.cart_item_share_id)
                     or exists (select 1
                                  from reservation_allocations other
                                  join contribution_reservations r2 on r2.id = other.reservation_id
                                 where other.cart_item_share_id = mine.cart_item_share_id
                                   and other.reservation_id <> v_res.id
                                   and (r2.status = 'confirmed'
                                        or (r2.status = 'active' and r2.expires_at > now())))))
           or v_received is distinct from v_expected
      into v_unplaceable;
  end if;

  if v_unplaceable then
    insert into contributions
      (reservation_id, round_id, session_id, participant_id,
       order_amount, tip_amount, webhook_event_id, applied_to_prepaid_balance)
    values (v_res.id, null, v_res.session_id, v_res.participant_id,
            v_received, 0, p_event_id, true)
    returning id into v_contribution_id;

    update contribution_reservations set status = 'cancelled', settled_at = now()
     where id = v_res.id and status = 'active';

    update sessions
       set prepaid_balance = prepaid_balance + v_received,
           status = case when status = 'closed' then status else 'requires_staff_attention' end
     where id = v_res.session_id;

    update webhook_events set processed_at = now() where id = p_event_id;
    return jsonb_build_object('status', 'credited', 'reason', 'tab_unplaceable',
                              'contribution_id', v_contribution_id, 'reservation_id', v_res.id,
                              'credited_amount', v_received);
  end if;

  insert into contributions
    (reservation_id, round_id, session_id, participant_id,
     order_amount, tip_amount, webhook_event_id, applied_to_prepaid_balance)
  values (v_res.id, null, v_res.session_id, v_res.participant_id,
          v_res.order_amount, v_res.tip_amount, p_event_id, false)
  returning id into v_contribution_id;

  update contribution_reservations set status = 'confirmed', settled_at = now() where id = v_res.id;
  update webhook_events set processed_at = now() where id = p_event_id;

  return jsonb_build_object('status', 'settled', 'contribution_id', v_contribution_id,
                            'reservation_id', v_res.id,
                            'session_closed', try_close_session(v_res.session_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Staff: write off, close, and what the kitchen screen lists.
-- ---------------------------------------------------------------------------

/**
 * The whole remaining tab of a table that left, never part of it: a write-off
 * that could pick items or amounts would be a discount, which the MVP does not
 * have.
 */
create or replace function staff_write_off(p_session_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session   sessions;
  v_amount    bigint;
  v_write_off uuid;
begin
  select * into v_session from sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_session');
  end if;
  if v_session.bill_requested_at is null then
    return jsonb_build_object('status', 'rejected', 'reason', 'bill_not_requested');
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'reason_required');
  end if;
  if exists (select 1 from session_tab_shares(p_session_id) t where is_share_held(t.id)) then
    return jsonb_build_object('status', 'rejected', 'reason', 'tab_held');
  end if;

  select coalesce(sum(owed_amount), 0) into v_amount from session_tab_shares(p_session_id);
  if v_amount = 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'nothing_to_write_off');
  end if;

  insert into write_offs (session_id, amount, reason)
  values (p_session_id, v_amount, btrim(p_reason))
  returning id into v_write_off;

  insert into write_off_shares (write_off_id, cart_item_share_id, amount)
  select v_write_off, t.id, t.owed_amount from session_tab_shares(p_session_id) t;

  perform staff_log('write_off', v_write_off, p_session_id,
                    jsonb_build_object('amount', v_amount, 'reason', btrim(p_reason)));

  return jsonb_build_object('status', 'written_off', 'write_off_id', v_write_off,
                            'amount', v_amount, 'closed', try_close_session(p_session_id));
end;
$$;

create or replace function staff_close_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_blockers text[];
begin
  perform 1 from sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_session');
  end if;
  if (select status from sessions where id = p_session_id) = 'closed' then
    return jsonb_build_object('status', 'closed', 'already', true);
  end if;

  v_blockers := session_close_blockers(p_session_id);
  if cardinality(v_blockers) > 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'not_closable',
                              'blockers', to_jsonb(v_blockers));
  end if;

  perform try_close_session(p_session_id);
  perform staff_log('close_session', p_session_id, p_session_id, '{}'::jsonb);
  return jsonb_build_object('status', 'closed', 'already', false);
end;
$$;

create or replace function staff_open_tables()
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'session_id',        s.id,
           'table',             t.label,
           'status',            s.status,
           'service_mode',      s.service_mode,
           'bill_requested_at', s.bill_requested_at,
           'prepaid_balance',   s.prepaid_balance,
           'tab',               tab_summary(s.id),
           'blockers',          to_jsonb(session_close_blockers(s.id)))
         order by t.label), '[]'::jsonb)
    from sessions s
    join tables t on t.id = s.table_id
   where s.status <> 'closed';
$$;

-- ---------------------------------------------------------------------------
-- 10. Staff functions from 20260928000100 that assumed every reservation has
-- a round, or that a cleared table is always `open`.
-- ---------------------------------------------------------------------------
create or replace function staff_resolve_if_clear(p_session_id uuid)
returns boolean
language plpgsql
as $$
declare
  v_cleared integer;
begin
  update sessions
     set status = (case when bill_requested_at is not null then 'settling' else 'open' end)::session_status
   where id = p_session_id
     and status = 'requires_staff_attention'
     and not exists (
       select 1 from jsonb_array_elements(staff_alert_reasons(p_session_id)) r
        where r ->> 'kind' <> 'unknown');
  get diagnostics v_cleared = row_count;

  -- Resolving the last problem may be what lets a table that asked for the
  -- bill close.
  perform try_close_session(p_session_id);
  return v_cleared = 1;
end;
$$;

create or replace function staff_release_reservation(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res contribution_reservations;
begin
  select * into v_res from contribution_reservations where id = p_reservation_id;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_reservation');
  end if;

  -- Same lock the payment for this reservation would take.
  if v_res.round_id is null then
    perform 1 from sessions where id = v_res.session_id for update;
  else
    perform lock_round(v_res.round_id);
  end if;
  select * into v_res from contribution_reservations where id = p_reservation_id;

  if v_res.status <> 'active' or v_res.expires_at <= now() then
    return jsonb_build_object('status', 'rejected', 'reason', 'reservation_not_live');
  end if;

  update contribution_reservations set status = 'cancelled', settled_at = now()
   where id = p_reservation_id;

  perform staff_log('release_reservation', p_reservation_id, v_res.session_id,
                    jsonb_build_object('round_id', v_res.round_id,
                                       'amount', v_res.order_amount + v_res.tip_amount));

  return jsonb_build_object('status', 'released', 'reservation_id', p_reservation_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10b. Alerts: a closed table with late money on it is still listed.
-- ---------------------------------------------------------------------------
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
        -- A table that already closed cannot be flagged — its QR may be seating
        -- the next party — but late money on it still needs a human.
        or (s.status = 'closed'
            and exists (select 1 from jsonb_array_elements(staff_alert_reasons(s.id)) r
                         where r ->> 'kind' = 'money_not_placed'))
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

-- ---------------------------------------------------------------------------
-- 11. The three functions that change by a line or two, in full.
-- ---------------------------------------------------------------------------
create or replace function add_cart_item(
  p_session_id     uuid,
  p_participant_id uuid,
  p_product_id     uuid,
  p_quantity       integer default 1,
  p_shared_with    uuid[]  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session sessions;
  v_round   rounds;
  v_product products;
  v_item    cart_items;
  v_caller  uuid;
  v_owners  uuid[];
  v_amounts bigint[];
  i         integer;
begin
  v_caller := current_participant_id();
  if v_caller is not null and v_caller <> p_participant_id then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'cannot order on behalf of another participant';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_quantity');
  end if;

  select * into v_session from sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_session');
  end if;

  -- The bill was asked for: nothing new, whatever the status says (a late
  -- payment can flag a settling table without reopening it).
  if v_session.status in ('closed', 'settling') or v_session.bill_requested_at is not null then
    return jsonb_build_object('status', 'rejected', 'reason', 'session_closed');
  end if;

  if not exists (
    select 1 from participants where id = p_participant_id and session_id = p_session_id
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'participant_not_in_session');
  end if;

  select * into v_product
    from products
   where id = p_product_id and venue_id = v_session.venue_id;

  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_product');
  end if;

  if not v_product.is_available then
    return jsonb_build_object('status', 'rejected', 'reason', 'product_unavailable');
  end if;

  -- Validated before anything is written, so a bad owner list never leaves a
  -- half-built item behind.
  v_owners := coalesce(nullif(p_shared_with, '{}'), array[p_participant_id]);
  if exists (
    select 1 from unnest(v_owners) as o
     where not exists (select 1 from participants where id = o and session_id = p_session_id)
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_sharer');
  end if;

  -- D11. Resolves to the round in draft, or opens the overflow round when the
  -- previous one has already gone to collection.
  v_round := ensure_draft_round(p_session_id);

  -- SNAPSHOT 2: price and tax are copied off the menu here and never read again.
  insert into cart_items
    (round_id, product_id, quantity, unit_price, tax_rate, added_by_participant_id)
  values (v_round.id, v_product.id, p_quantity,
          v_product.unit_price, v_product.tax_rate, p_participant_id)
  returning * into v_item;

  -- I1a: largest-remainder, so the shares sum to line_total exactly however
  -- awkward the division.
  v_amounts := allocate_evenly(v_item.line_total, cardinality(v_owners));

  for i in 1 .. cardinality(v_owners) loop
    insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
    values (v_item.id, v_round.id, v_owners[i], v_amounts[i]);
  end loop;

  return jsonb_build_object(
    'status',       'added',
    'cart_item_id', v_item.id,
    'round_id',     v_round.id,
    'round_number', v_round.round_number,
    'line_total',   v_item.line_total,
    'shares',       (select jsonb_agg(jsonb_build_object(
                              'share_id',       s.id,
                              'participant_id', s.participant_id,
                              'owed_amount',    s.owed_amount)
                            order by s.id)
                       from cart_item_shares s where s.cart_item_id = v_item.id));
end;
$$;

CREATE OR REPLACE FUNCTION public.close_round(p_session_id uuid, p_split_mode text DEFAULT 'as_ordered'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_session      sessions;
  v_round        rounds;
  v_total        bigint;
  v_participants uuid[];
  v_targets      bigint[];
  v_item         record;
  v_left_item    bigint;
  v_left_target  bigint;
  v_p            integer;
  v_take         bigint;
  v_outcome      text;
begin
  if p_split_mode not in ('as_ordered', 'equal') then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_split_mode');
  end if;

  select * into v_session from sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_session');
  end if;

  -- The bill was asked for: nothing new, whatever the status says (a late
  -- payment can flag a settling table without reopening it).
  if v_session.status in ('closed', 'settling') or v_session.bill_requested_at is not null then
    return jsonb_build_object('status', 'rejected', 'reason', 'session_closed');
  end if;

  select * into v_round
    from rounds
   where session_id = p_session_id and status = 'draft'
     for update;

  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'no_open_round');
  end if;

  v_total := round_total(v_round.id);
  if v_total = 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'empty_round');
  end if;

  if p_split_mode = 'equal' then
    select coalesce(array_agg(id order by joined_at, id), '{}') into v_participants
      from participants
     where session_id = p_session_id and kind = 'guest';

    if cardinality(v_participants) = 0 then
      return jsonb_build_object('status', 'rejected', 'reason', 'no_participants');
    end if;

    delete from cart_item_shares where round_id = v_round.id;

    v_targets := allocate_evenly(v_total, cardinality(v_participants));
    v_p := 1;
    v_left_target := v_targets[1];

    for v_item in
      select id, line_total from cart_items
       where round_id = v_round.id and status = 'active'
       order by created_at, id
    loop
      v_left_item := v_item.line_total;

      while v_left_item > 0 loop
        while v_left_target = 0 and v_p < cardinality(v_targets) loop
          v_p := v_p + 1;
          v_left_target := v_targets[v_p];
        end loop;
        exit when v_left_target = 0;

        v_take := least(v_left_item, v_left_target);

        insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
        values (v_item.id, v_round.id, v_participants[v_p], v_take);

        v_left_item   := v_left_item - v_take;
        v_left_target := v_left_target - v_take;
      end loop;
    end loop;
  end if;

  if v_round.requires_prepayment then
    update rounds set status = 'locked_for_payment', closed_at = now() where id = v_round.id;
    v_outcome := 'collecting';

  elsif v_session.service_mode = 'hybrid' then
    if v_session.prepaid_balance >= v_total then
      update sessions
         set prepaid_balance = prepaid_balance - v_total
       where id = p_session_id;
      -- Paid, just not by a contribution. Without this the tab would charge it again.
      update rounds set paid_from_balance = true where id = v_round.id;
      v_outcome := 'dispatched';
    else
      update rounds set status = 'locked_for_payment', closed_at = now() where id = v_round.id;
      v_outcome := 'collecting';
    end if;

  else
    v_outcome := 'dispatched';
  end if;

  if v_outcome = 'dispatched' then
    update rounds
       set status = 'paid_and_dispatched', closed_at = now(), dispatched_at = now()
     where id = v_round.id;

    insert into dispatches (round_id, channel)
    values (v_round.id, 'kds'), (v_round.id, 'print')
        on conflict (round_id, channel) do nothing;
  end if;

  return jsonb_build_object(
    'status',       v_outcome,
    'round_id',     v_round.id,
    'round_number', v_round.round_number,
    'round_total',  v_total,
    'split_mode',   p_split_mode,
    'service_mode', v_session.service_mode);
end;
$function$;

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

  -- A tab payment belongs to the session, not a round: settled under the
  -- session lock by its own function. The round path below is unchanged.
  if v_res.round_id is null then
    return confirm_tab_payment(v_event_id, v_res.id, p_amount, v_approved);
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

  -- A round still collecting when the bill was asked for may be the last
  -- thing keeping the table open.
  perform try_close_session(v_round.session_id);

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
-- 12. Grants. Diners may ask for the bill and reserve the tab, exactly as they
-- may reserve a round; everything else is the servers' connection only.
-- ---------------------------------------------------------------------------
revoke all on function
  tg_reservation_session(),
  session_tab_shares(uuid),
  tab_summary(uuid),
  session_close_blockers(uuid),
  try_close_session(uuid),
  request_bill_core(uuid),
  staff_request_bill(uuid),
  confirm_tab_payment(uuid, uuid, bigint, boolean),
  staff_write_off(uuid, text),
  staff_close_session(uuid),
  staff_open_tables(),
  staff_alerts(interval),
  staff_resolve_if_clear(uuid),
  staff_release_reservation(uuid),
  confirm_webhook(text, text, text, text, bigint, jsonb, boolean)
from public, anon, authenticated;

revoke all on function request_bill(uuid, uuid), reserve_tab(uuid, uuid, text, text, bigint)
  from public;
grant execute on function request_bill(uuid, uuid), reserve_tab(uuid, uuid, text, text, bigint)
  to anon, authenticated;
