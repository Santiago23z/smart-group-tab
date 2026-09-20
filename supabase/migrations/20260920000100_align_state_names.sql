-- Smart Group Tab — align state names with the project specification.
--
-- Three names disagreed with CLAUDE.md. The specification is authoritative, so the
-- schema moves:
--
--   round_status    pending_payment       -> locked_for_payment
--   round_status    needs_staff_attention -> requires_staff_attention
--   session_status  needs_staff_attention -> requires_staff_attention
--
-- `alter type ... rename value` keeps the pg_enum OID, so every dependency holding a
-- PARSED reference follows on its own: the partial index sessions_one_live_per_table,
-- check constraints, and RLS policies. Nothing there needs restating.
--
-- Function bodies are the exception. Both plpgsql and sql functions are stored as TEXT
-- and parsed at execution, so a body carrying the old label keeps carrying it and fails
-- at runtime once the label is gone. Four functions still in force contain one:
--
--   open_or_join_session (from ...001100)   1 literal
--   close_round          (from ...001200)   2 literals
--   reserve_contribution (from ...001200)   1 literal
--   confirm_webhook      (from ...001200)   5 literals
--
-- Their bodies below were taken from pg_get_functiondef against a database migrated
-- through ...001300 — not retyped from the files — and only those 9 literals were
-- substituted. Line counts are unchanged. This matters most for confirm_webhook, whose
-- `and status = 'locked_for_payment'` guard on the dispatch transition is recorded in
-- README.md as UNDETECTABLE by the test suite: were it dropped here, nothing would go red.
--
-- This migration also adds refunds.kind. CLAUDE.md asks for `reversed`/`refunded`, which
-- is a different axis from the existing pending/completed/rejected lifecycle: kind says
-- how the money came back, status says how far along it is. A reversal the bank is still
-- processing is both `reversed` and `pending`, and collapsing them would make the UI claim
-- money is back while it is not.

-- ---------------------------------------------------------------------------
-- 1. The renames.
-- ---------------------------------------------------------------------------
alter type round_status   rename value 'pending_payment'       to 'locked_for_payment';
alter type round_status   rename value 'needs_staff_attention' to 'requires_staff_attention';
alter type session_status rename value 'needs_staff_attention' to 'requires_staff_attention';

-- ---------------------------------------------------------------------------
-- 2. refunds.kind.
--
-- No RPC has ever written to `refunds`, so the table is empty everywhere and the column
-- can be `not null` with no default. A default would silently classify a historical
-- refund as a kind it may not be, and a wrong audit record over real money is worse than
-- a migration that stops. If rows do exist, stop and say why rather than guessing.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from refunds) then
    raise exception using
      errcode = 'integrity_constraint_violation',
      message = 'refunds is not empty; classify each existing row as reversed or refunded '
                'by hand and backfill kind before this migration can add it as not null';
  end if;
end $$;

create type refund_kind as enum (
  'reversed',  -- the original charge was voided inside the provider's reversal window
  'refunded'   -- the money was returned afterwards as a separate movement
);

alter table refunds add column kind refund_kind not null;

-- ---------------------------------------------------------------------------
-- 3. The four function bodies, relabelled.
-- ---------------------------------------------------------------------------

-- open_or_join_session --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.open_or_join_session(p_qr_token text, p_nickname text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_table       tables;
  v_venue       venues;
  v_session     sessions;
  v_round       rounds;
  v_participant participants;
  v_created     boolean := false;
begin
  if p_nickname is null or length(btrim(p_nickname)) = 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'nickname_required');
  end if;

  -- Serializes the scan. Ten phones hitting one QR at the same instant must open
  -- one tab, not ten.
  select * into v_table
    from tables
   where qr_token = p_qr_token and is_active
     for update;

  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_table');
  end if;

  select * into v_venue from venues where id = v_table.venue_id;

  select * into v_session
    from sessions
   where table_id = v_table.id
     and status in ('open', 'settling', 'requires_staff_attention');

  if not found then
    -- SNAPSHOT 1 (D6): the venue's configuration is copied, not referenced.
    insert into sessions (table_id, venue_id, service_mode, tip_mode, reservation_ttl)
    values (v_table.id, v_table.venue_id,
            v_venue.default_service_mode, v_venue.default_tip_mode, v_venue.reservation_ttl)
    returning * into v_session;
    v_created := true;
  end if;

  v_round := ensure_draft_round(v_session.id);

  begin
    insert into participants (session_id, nickname, kind)
    values (v_session.id, btrim(p_nickname), 'guest')
    returning * into v_participant;
  exception when unique_violation then
    -- Two Santis at one table would make "pay for my items" ambiguous, so the UI
    -- has to ask again rather than us silently renaming anyone.
    return jsonb_build_object(
      'status', 'rejected', 'reason', 'nickname_taken', 'session_id', v_session.id);
  end;

  return jsonb_build_object(
    'status',          'joined',
    'created_session', v_created,
    'session_id',      v_session.id,
    'participant_id',  v_participant.id,
    'round_id',        v_round.id,
    'round_number',    v_round.round_number,
    'service_mode',    v_session.service_mode,
    'venue_id',        v_table.venue_id);
end;
$function$;

-- close_round --------------------------------------------------------------
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
    update rounds set status = 'locked_for_payment', closed_at = now() where id = v_round.id;
    v_outcome := 'collecting';

  elsif v_session.service_mode = 'hybrid' then
    if v_session.prepaid_balance >= v_total then
      update sessions
         set prepaid_balance = prepaid_balance - v_total
       where id = p_session_id;
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

-- reserve_contribution --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_contribution(p_round_id uuid, p_participant_id uuid, p_mode split_mode, p_idempotency_key text, p_amount bigint DEFAULT NULL::bigint, p_share_ids uuid[] DEFAULT NULL::uuid[], p_tip_amount bigint DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  if v_round.status <> 'locked_for_payment' then
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
$function$;

-- confirm_webhook --------------------------------------------------------------
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
           status = case when status = 'closed' then status else 'requires_staff_attention' end
     where id = v_round.session_id;

    update rounds
       set status = 'requires_staff_attention'
     where id = v_round.id
       and status = 'locked_for_payment';

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
       and status = 'locked_for_payment';

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
$function$;

-- ---------------------------------------------------------------------------
-- 4. Grants, restated.
--
-- `create or replace function` preserves the existing ACL, so these are defence in depth
-- rather than repair. They restate exactly what ...000900, ...001100 and ...001200 set:
-- confirm_webhook is the only one of the four a client may not call, because it is the
-- ledger's write path and is reached only by the verified webhook adapter.
-- ---------------------------------------------------------------------------
grant execute on function
  open_or_join_session(text, text),
  close_round(uuid, text),
  reserve_contribution(uuid, uuid, split_mode, text, bigint, uuid[], bigint)
to anon, authenticated;

revoke all on function
  confirm_webhook(text, text, text, text, bigint, jsonb, boolean)
from public, anon, authenticated;
