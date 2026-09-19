-- Smart Group Tab — webhook settlement.
--
-- The ledger is reconstructible from PSP webhooks and from nothing else. Client
-- callbacks are never trusted: in a nightclub the phone loses signal on the way
-- back from the gateway, and that must not cost anyone their order.
--
-- Two rules govern everything below:
--
--   I2 — the round fires to the kitchen exactly once, no matter how many times
--        the completion event is observed.
--   I3 — an approved webhook is never rejected. The money already moved; our
--        only choice is where to record it, never whether to.

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
begin
  -- -------------------------------------------------------------------------
  -- 1. The idempotency gate (D7).
  --
  -- Inserting the PSP's own event id IS the gate. A retry collides here and
  -- leaves before touching the ledger. Everything downstream can therefore
  -- assume it is running for the first and only time.
  -- -------------------------------------------------------------------------
  insert into webhook_events (provider, event_id, payload, signature_verified)
  values (p_provider, p_event_id, coalesce(p_payload, '{}'::jsonb),
          coalesce(p_signature_verified, false))
      on conflict (provider, event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return jsonb_build_object('status', 'duplicate_event', 'event_id', p_event_id);
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Locate the reservation. An orphan is still recorded above — a payment we
  --    cannot explain is exactly the kind of thing that must leave a trace.
  -- -------------------------------------------------------------------------
  select * into v_res
    from contribution_reservations
   where psp_reference = p_psp_reference;

  if not found then
    update webhook_events set processed_at = now() where id = v_event_id;
    return jsonb_build_object('status', 'unknown_reference', 'event_id', p_event_id);
  end if;

  -- 3. Serialize on the round, then re-read: anything could have changed while
  --    we waited for the lock.
  v_round := lock_round(v_res.round_id);
  select * into v_res from contribution_reservations where id = v_res.id;

  if v_res.status = 'confirmed' then
    update webhook_events set processed_at = now() where id = v_event_id;
    return jsonb_build_object('status', 'already_settled', 'reservation_id', v_res.id);
  end if;

  -- -------------------------------------------------------------------------
  -- 4a. Declined. Nothing moved, so release the shares at once rather than
  --     making the table wait out a TTL that no longer means anything.
  -- -------------------------------------------------------------------------
  if p_outcome is distinct from 'approved' then
    update contribution_reservations
       set status = 'cancelled', settled_at = now()
     where id = v_res.id and status = 'active';

    update webhook_events set processed_at = now() where id = v_event_id;
    return jsonb_build_object(
      'status', 'released', 'reservation_id', v_res.id, 'outcome', p_outcome);
  end if;

  -- -------------------------------------------------------------------------
  -- From here the payment was approved. The money is gone from someone's
  -- account and there is no path back that does not involve a human.
  -- -------------------------------------------------------------------------
  v_expected := v_res.order_amount + v_res.tip_amount;
  v_received := coalesce(p_amount, v_expected);

  -- Did this reservation's shares get retaken while it was expired? Note that a
  -- live reservation cannot be in this position: I1b guarantees nobody else
  -- could have claimed its shares.
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

  -- -------------------------------------------------------------------------
  -- 4b. I3 — the money moved but we cannot apply it to what it was meant for.
  --     Either its shares are gone, or the PSP's amount disagrees with ours.
  --     Both land here: record it, credit the table, escalate to a human (D2).
  --     Never reject.
  -- -------------------------------------------------------------------------
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

    -- A round that already fired stays fired: un-dispatching food that is on the
    -- grill is not something the kitchen can do. The staff flag lives on the
    -- session, which is what the KDS alert tray reads.
    update rounds
       set status = 'needs_staff_attention'
     where id = v_round.id
       and status = 'pending_payment';

    update webhook_events set processed_at = now() where id = v_event_id;

    return jsonb_build_object(
      'status',           'credited',
      'reason',           case when v_shares_taken then 'shares_retaken'
                               else 'amount_mismatch' end,
      'contribution_id',  v_contribution_id,
      'reservation_id',   v_res.id,
      'credited_amount',  v_received,
      'expected_amount',  v_expected);
  end if;

  -- -------------------------------------------------------------------------
  -- 4c. The ordinary path: settle it.
  -- -------------------------------------------------------------------------
  insert into contributions
    (reservation_id, round_id, session_id, participant_id,
     order_amount, tip_amount, webhook_event_id, applied_to_prepaid_balance)
  values (v_res.id, v_res.round_id, v_round.session_id, v_res.participant_id,
          v_res.order_amount, v_res.tip_amount, v_event_id, false)
  returning id into v_contribution_id;

  update contribution_reservations
     set status = 'confirmed', settled_at = now()
   where id = v_res.id;

  -- -------------------------------------------------------------------------
  -- 5. I2 — the transition that fires the kitchen.
  --
  -- Completion is "every active share is settled", not "the sum reached the
  -- total" (D16). The two coincide by I1a, but the share version is what fires
  -- the kitchen, and a tip can never satisfy it (D10).
  --
  -- What actually makes this exactly-once is the pair above: the idempotency
  -- gate, which admits each PSP event once, and the round lock, which serializes
  -- callers so that only the one completing the final share ever sees a settled
  -- round. Mutation testing bears this out — breaking the gate fails the suite
  -- immediately, while removing the `and status = 'pending_payment'` clause
  -- below changes nothing observable.
  --
  -- That clause and the `on conflict` on dispatches are kept as defence in depth,
  -- not as the mechanism. If anyone ever weakens the lock, they become the thing
  -- standing between a diner and a duplicate comanda — but they are not tested,
  -- because the scenario they cover is unreachable through this API today.
  -- -------------------------------------------------------------------------
  if round_is_fully_settled(v_round.id) then
    update rounds
       set status = 'paid_and_dispatched', dispatched_at = now()
     where id = v_round.id
       and status = 'pending_payment';

    get diagnostics v_transitioned = row_count;

    if v_transitioned = 1 then
      -- Written inside the transaction, delivered outside it. An HTTP call here
      -- would roll back a payment that already moved real money.
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

-- Deliberately not granted to anon or authenticated: only the webhook endpoint,
-- running as service_role, may settle money.
revoke all on function
  confirm_webhook(text, text, text, text, bigint, jsonb, boolean)
from public, anon, authenticated;
