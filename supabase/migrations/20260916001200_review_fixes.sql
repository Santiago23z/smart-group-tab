-- Smart Group Tab — fixes from the first code review.
--
-- Five defects, four of which had shipped with a green suite. They are worth
-- naming as a group because they rhyme: each one lived in the gap between two
-- things that were individually tested.

-- ---------------------------------------------------------------------------
-- 1. contributions: one row per webhook event, not one per reservation.
--
-- The old `unique (reservation_id)` encoded an assumption that a reservation is
-- paid at most once. Wompi will happily create a second transaction against the
-- same reference if the diner has the checkout open on two phones, and that money
-- is just as real as the first. Keyed on the webhook event instead, the table now
-- says what I3 actually means: every approved webhook produces exactly one
-- ledger row.
-- ---------------------------------------------------------------------------
alter table contributions drop constraint contributions_reservation_id_key;
alter table contributions add constraint contributions_webhook_event_id_key
  unique (webhook_event_id);
create index contributions_reservation_idx on contributions (reservation_id);

-- ---------------------------------------------------------------------------
-- 2. reserve_contribution: a split must carry every claim on the share with it.
--
-- free_shares() treats a share under a lapsed-but-unsettled hold as available,
-- which is right — the diner wandered off and the table should not be stuck. But
-- splitting it left the lapsed reservation's allocation naming the ORIGINAL
-- amount while the share shrank underneath it. If that payment then landed,
-- confirm_webhook looked for another reservation on the same share id, found none
-- (the new claimant holds the NEW share), and settled it in full.
--
-- Reproduced: an item worth 100 collected 140, fired the kitchen, and flagged
-- nothing. I1a still held (60 + 40 = 100) and the allocation-sum trigger still
-- held (100 = 100), so no constraint could catch it.
--
-- The fix keeps the split but propagates it: the lapsed claim now covers both
-- halves. Its total is unchanged, so it can still settle for exactly what the
-- diner is paying — and if someone else has taken either half, the existing
-- shares-retaken probe sees it and routes the money to credit.
-- ---------------------------------------------------------------------------
create or replace function reserve_contribution(
  p_round_id        uuid,
  p_participant_id  uuid,
  p_mode            split_mode,
  p_idempotency_key text,
  p_amount          bigint  default null,
  p_share_ids       uuid[]  default null,
  p_tip_amount      bigint  default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_round       rounds;
  v_existing    contribution_reservations;
  v_reservation contribution_reservations;
  v_caller      uuid;
  v_target      uuid[] := '{}';
  v_total       bigint := 0;
  v_needed      bigint;
  v_share       cart_item_shares;
  v_new_share   uuid;
begin
  v_caller := current_participant_id();
  if v_caller is not null and v_caller <> p_participant_id then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'cannot reserve on behalf of another participant';
  end if;

  v_round := lock_round(p_round_id);

  select * into v_existing
    from contribution_reservations
   where idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'status',         'duplicate',
      'reservation_id', v_existing.id,
      'psp_reference',  v_existing.psp_reference,
      'order_amount',   v_existing.order_amount,
      'tip_amount',     v_existing.tip_amount,
      'expires_at',     v_existing.expires_at);
  end if;

  if v_round.status <> 'pending_payment' then
    return reservation_rejection(p_round_id, 'round_not_collectable');
  end if;

  if not exists (
    select 1 from participants
     where id = p_participant_id and session_id = v_round.session_id
  ) then
    return reservation_rejection(p_round_id, 'participant_not_in_session');
  end if;

  if p_mode = 'my_items' then
    select coalesce(array_agg(s.id), '{}') into v_target
      from free_shares(p_round_id) s
     where s.participant_id = p_participant_id;

  elsif p_mode = 'remaining' then
    select coalesce(array_agg(s.id), '{}') into v_target
      from free_shares(p_round_id) s;

  elsif p_mode = 'specific_shares' then
    if p_share_ids is null or cardinality(p_share_ids) = 0 then
      return reservation_rejection(p_round_id, 'no_shares_given');
    end if;

    if exists (
      select 1 from unnest(p_share_ids) as sid
       where not exists (select 1 from active_shares(p_round_id) a where a.id = sid)
    ) then
      return reservation_rejection(p_round_id, 'unknown_share');
    end if;

    if exists (select 1 from unnest(p_share_ids) as sid where is_share_held(sid)) then
      return reservation_rejection(p_round_id, 'shares_taken');
    end if;

    v_target := p_share_ids;

  elsif p_mode = 'free_amount' then
    if p_amount is null or p_amount <= 0 then
      return reservation_rejection(p_round_id, 'invalid_amount');
    end if;

    if p_amount > round_outstanding(p_round_id) then
      return reservation_rejection(p_round_id, 'amount_exceeds_outstanding');
    end if;

    for v_share in select * from free_shares(p_round_id) loop
      v_needed := p_amount - v_total;
      exit when v_needed <= 0;

      if v_share.owed_amount <= v_needed then
        v_target := v_target || v_share.id;
        v_total  := v_total + v_share.owed_amount;
      else
        insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
        values (v_share.cart_item_id, v_share.round_id, v_share.participant_id, v_needed)
        returning id into v_new_share;

        -- Carry any unsettled claim across the split. 'active' here includes
        -- lapsed holds: they are exactly the ones that can still be approved, and
        -- exactly the ones this used to strand.
        insert into reservation_allocations (reservation_id, cart_item_share_id, amount)
        select ra.reservation_id, v_new_share, v_needed
          from reservation_allocations ra
          join contribution_reservations r on r.id = ra.reservation_id
         where ra.cart_item_share_id = v_share.id
           and r.status = 'active';

        update reservation_allocations ra
           set amount = ra.amount - v_needed
          from contribution_reservations r
         where r.id = ra.reservation_id
           and ra.cart_item_share_id = v_share.id
           and r.status = 'active';

        update cart_item_shares
           set owed_amount = owed_amount - v_needed
         where id = v_share.id;

        v_target := v_target || v_new_share;
        v_total  := v_total + v_needed;
        exit;
      end if;
    end loop;
  end if;

  if cardinality(v_target) = 0 then
    return reservation_rejection(p_round_id, 'nothing_available');
  end if;

  select coalesce(sum(owed_amount), 0) into v_total
    from cart_item_shares
   where id = any(v_target);

  insert into contribution_reservations
    (round_id, participant_id, order_amount, tip_amount,
     idempotency_key, psp_reference, expires_at)
  select p_round_id, p_participant_id, v_total, coalesce(p_tip_amount, 0),
         p_idempotency_key,
         'sgt-' || replace(gen_random_uuid()::text, '-', ''),
         now() + s.reservation_ttl
    from sessions s
   where s.id = v_round.session_id
  returning * into v_reservation;

  insert into reservation_allocations (reservation_id, cart_item_share_id, amount)
  select v_reservation.id, cis.id, cis.owed_amount
    from cart_item_shares cis
   where cis.id = any(v_target);

  return jsonb_build_object(
    'status',         'reserved',
    'reservation_id', v_reservation.id,
    'psp_reference',  v_reservation.psp_reference,
    'order_amount',   v_reservation.order_amount,
    'tip_amount',     v_reservation.tip_amount,
    'expires_at',     v_reservation.expires_at,
    'share_ids',      to_jsonb(v_target),
    'outstanding',    round_outstanding(p_round_id));

exception
  when unique_violation then
    select * into v_existing
      from contribution_reservations
     where idempotency_key = p_idempotency_key;

    if found then
      return jsonb_build_object(
        'status',         'duplicate',
        'reservation_id', v_existing.id,
        'psp_reference',  v_existing.psp_reference,
        'order_amount',   v_existing.order_amount,
        'tip_amount',     v_existing.tip_amount,
        'expires_at',     v_existing.expires_at);
    end if;
    raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. confirm_webhook: two paths that quietly lost an approved payment.
--
--   a) A second approval against an already-settled reservation returned
--      'already_settled' and recorded nothing. Real money, no ledger row.
--   b) An approval we cannot place stamped processed_at, which removes it from
--      webhook_events_unprocessed_idx — the only index built to find these. It
--      left a trace and no way to trip over it.
-- ---------------------------------------------------------------------------
create or replace function confirm_webhook(
  p_provider           text,
  p_event_id           text,
  p_psp_reference      text,
  p_outcome            text,
  p_amount             bigint,
  p_payload            jsonb   default '{}'::jsonb,
  p_signature_verified boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
           status = case when status = 'closed' then status else 'needs_staff_attention' end
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

  if v_shares_taken or v_received is distinct from v_expected then
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
           status = case when status = 'closed' then status else 'needs_staff_attention' end
     where id = v_round.session_id;

    update rounds
       set status = 'needs_staff_attention'
     where id = v_round.id
       and status = 'pending_payment';

    update webhook_events set processed_at = now() where id = v_event_id;

    return jsonb_build_object(
      'status',          'credited',
      'reason',          case when v_shares_taken then 'shares_retaken'
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

  if round_is_fully_settled(v_round.id) then
    update rounds
       set status = 'paid_and_dispatched', dispatched_at = now()
     where id = v_round.id
       and status = 'pending_payment';

    get diagnostics v_transitioned = row_count;

    if v_transitioned = 1 then
      insert into dispatches (round_id, channel)
      values (v_round.id, 'kds'), (v_round.id, 'print')
          on conflict (round_id, channel) do nothing;
    end if;
  end if;

  update webhook_events set processed_at = now() where id = v_event_id;

  return jsonb_build_object(
    'status',          'settled',
    'contribution_id', v_contribution_id,
    'reservation_id',  v_res.id,
    'round_settled',   round_is_fully_settled(v_round.id),
    'dispatched',      coalesce(v_transitioned, 0) = 1);
end;
$$;

revoke all on function
  confirm_webhook(text, text, text, text, bigint, jsonb, boolean)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Authorization that was applied by hand and missed two functions.
--
-- add_cart_item checks both that the caller is who they claim and that they are
-- in the session. void_cart_item checked only the first; set_item_sharing checked
-- neither, despite being granted to anon. Anyone holding a cart_item_id could
-- move a whole bill onto one diner right before the round closed.
-- ---------------------------------------------------------------------------
create or replace function void_cart_item(p_cart_item_id uuid, p_participant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item   cart_items;
  v_round  rounds;
  v_caller uuid;
begin
  v_caller := current_participant_id();
  if v_caller is not null and v_caller <> p_participant_id then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'cannot void on behalf of another participant';
  end if;

  select * into v_item from cart_items where id = p_cart_item_id;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_item');
  end if;

  v_round := lock_round(v_item.round_id);

  -- Being yourself is not enough; you have to be at this table.
  if not exists (
    select 1 from participants
     where id = p_participant_id and session_id = v_round.session_id
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'participant_not_in_session');
  end if;

  if v_round.status <> 'draft' then
    return jsonb_build_object('status', 'rejected', 'reason', 'round_not_editable');
  end if;

  if v_item.status = 'voided' then
    return jsonb_build_object('status', 'voided', 'cart_item_id', v_item.id);
  end if;

  delete from cart_item_shares where cart_item_id = v_item.id;

  update cart_items
     set status = 'voided', voided_at = now()
   where id = v_item.id;

  return jsonb_build_object(
    'status',       'voided',
    'cart_item_id', v_item.id,
    'round_id',     v_round.id,
    'round_total',  round_total(v_round.id));
end;
$$;

drop function if exists set_item_sharing(uuid, uuid[]);

create or replace function set_item_sharing(
  p_cart_item_id   uuid,
  p_participant_ids uuid[],
  p_participant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item    cart_items;
  v_round   rounds;
  v_caller  uuid;
  v_amounts bigint[];
  i         integer;
begin
  v_caller := current_participant_id();
  if v_caller is not null and v_caller <> p_participant_id then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'cannot reshare on behalf of another participant';
  end if;

  if p_participant_ids is null or cardinality(p_participant_ids) = 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'no_participants');
  end if;

  select * into v_item from cart_items where id = p_cart_item_id;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_item');
  end if;

  v_round := lock_round(v_item.round_id);

  if not exists (
    select 1 from participants
     where id = p_participant_id and session_id = v_round.session_id
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'participant_not_in_session');
  end if;

  if v_round.status <> 'draft' or v_item.status <> 'active' then
    return jsonb_build_object('status', 'rejected', 'reason', 'round_not_editable');
  end if;

  if exists (
    select 1 from unnest(p_participant_ids) as o
     where not exists (
       select 1 from participants where id = o and session_id = v_round.session_id)
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_sharer');
  end if;

  delete from cart_item_shares where cart_item_id = v_item.id;

  v_amounts := allocate_evenly(v_item.line_total, cardinality(p_participant_ids));
  for i in 1 .. cardinality(p_participant_ids) loop
    insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
    values (v_item.id, v_round.id, p_participant_ids[i], v_amounts[i]);
  end loop;

  return jsonb_build_object(
    'status',       'reshared',
    'cart_item_id', v_item.id,
    'shares',       (select jsonb_agg(jsonb_build_object(
                              'share_id',       s.id,
                              'participant_id', s.participant_id,
                              'owed_amount',    s.owed_amount)
                            order by s.id)
                       from cart_item_shares s where s.cart_item_id = v_item.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. close_round refused nothing about the session's own state.
--
-- add_cart_item rejects a closed or settling session; its neighbour did not. A
-- stale client could fire the kitchen for a table that had already left, and
-- under hybrid could spend credit out of a closed session.
-- ---------------------------------------------------------------------------
create or replace function close_round(p_session_id uuid, p_split_mode text default 'as_ordered')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  if v_session.status in ('closed', 'settling') then
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
    update rounds set status = 'pending_payment', closed_at = now() where id = v_round.id;
    v_outcome := 'collecting';

  elsif v_session.service_mode = 'hybrid' then
    if v_session.prepaid_balance >= v_total then
      update sessions
         set prepaid_balance = prepaid_balance - v_total
       where id = p_session_id;
      v_outcome := 'dispatched';
    else
      update rounds set status = 'pending_payment', closed_at = now() where id = v_round.id;
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
$$;

grant execute on function
  set_item_sharing(uuid, uuid[], uuid)
to anon, authenticated;
