-- Smart Group Tab — the atomic claim.
--
-- This function is where the product lives or dies. With an irreversible push
-- rail there is no auth/capture to fall back on: whatever this claims, the diner
-- is about to actually pay, and getting it back means a manual refund.
--
-- One function rather than one per mode, deliberately. All five modes share the
-- same preamble — lock, idempotency, state validation — and that preamble is
-- where the correctness lives. Duplicating it is duplicating the surface where it
-- can break.

create type split_mode as enum (
  'my_items',        -- the shares assigned to me
  'specific_shares', -- the shares I name
  'remaining',       -- every share nobody has claimed
  'free_amount'      -- free shares up to an amount, splitting the last one
);

-- Note: an equal split is not a mode here. It re-shards the round rather than
-- claiming against it, so it belongs to close_round(), and once it has run every
-- diner simply uses 'my_items'.

-- ---------------------------------------------------------------------------
-- Losing a race is a normal outcome, not an error.
--
-- Raising would roll back the transaction and take the fresh read with it,
-- leaving the client to guess. Returning carries the current state back so the UI
-- can re-render immediately — the diner who lost sees what is actually left
-- rather than an error they cannot act on.
-- ---------------------------------------------------------------------------
create or replace function reservation_rejection(p_round_id uuid, p_reason text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'status',      'rejected',
    'reason',      p_reason,
    'round_total', round_total(p_round_id),
    'outstanding', round_outstanding(p_round_id),
    'free_shares', coalesce((
      select jsonb_agg(jsonb_build_object(
               'share_id',       s.id,
               'cart_item_id',   s.cart_item_id,
               'participant_id', s.participant_id,
               'owed_amount',    s.owed_amount)
             order by s.owed_amount)
        from free_shares(p_round_id) s), '[]'::jsonb));
$$;

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
  -- The API layer proves identity; this is the backstop. When a request arrives
  -- with a participant in context it must match, so a guest cannot claim on
  -- someone else's behalf. Service-role callers (tests, webhooks) have no
  -- participant in context and are trusted.
  v_caller := current_participant_id();
  if v_caller is not null and v_caller <> p_participant_id then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'cannot reserve on behalf of another participant';
  end if;

  -- The single serialization point. Everything below runs alone for this round.
  v_round := lock_round(p_round_id);

  -- Idempotency is checked AFTER the lock, not before. Before the lock, two
  -- concurrent replays of one key would both miss and the loser would hit a raw
  -- unique violation instead of a clean duplicate.
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

  -- -------------------------------------------------------------------------
  -- Resolve the target set of shares.
  -- -------------------------------------------------------------------------
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

    -- I1b. Under the lock this read cannot go stale between here and the insert.
    if exists (select 1 from unnest(p_share_ids) as sid where is_share_held(sid)) then
      return reservation_rejection(p_round_id, 'shares_taken');
    end if;

    v_target := p_share_ids;

  elsif p_mode = 'free_amount' then
    if p_amount is null or p_amount <= 0 then
      return reservation_rejection(p_round_id, 'invalid_amount');
    end if;

    -- Refused outright rather than silently truncated: someone who meant to pay
    -- 50.000 should not discover they paid 12.000.
    if p_amount > round_outstanding(p_round_id) then
      return reservation_rejection(p_round_id, 'amount_exceeds_outstanding');
    end if;

    -- free_shares comes back cheapest-first, so at most one share is ever split
    -- and it is always the last one taken.
    for v_share in select * from free_shares(p_round_id) loop
      v_needed := p_amount - v_total;
      exit when v_needed <= 0;

      if v_share.owed_amount <= v_needed then
        v_target := v_target || v_share.id;
        v_total  := v_total + v_share.owed_amount;
      else
        -- The split. The remainder keeps the original share's participant_id:
        -- that column records who *consumed* the item, which does not change
        -- because someone else is paying for part of it. Who paid is recorded by
        -- the allocation, not by the share.
        insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
        values (v_share.cart_item_id, v_share.round_id, v_share.participant_id, v_needed)
        returning id into v_new_share;

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

  -- Recomputed from the rows themselves rather than trusted from the loop, so
  -- every mode reaches the insert the same way.
  select coalesce(sum(owed_amount), 0) into v_total
    from cart_item_shares
   where id = any(v_target);

  insert into contribution_reservations
    (round_id, participant_id, order_amount, tip_amount,
     idempotency_key, psp_reference, expires_at)
  select p_round_id, p_participant_id, v_total, coalesce(p_tip_amount, 0),
         p_idempotency_key,
         'sgt-' || replace(gen_random_uuid()::text, '-', ''),
         -- D8: the TTL comes from the session's snapshot, not from the venue's
         -- current setting.
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
  -- Belt to the lock's braces: if a duplicate key ever slips through, hand back
  -- the existing reservation rather than a raw constraint error.
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

grant execute on function
  reserve_contribution(uuid, uuid, split_mode, text, bigint, uuid[], bigint),
  reservation_rejection(uuid, text)
to anon, authenticated;
