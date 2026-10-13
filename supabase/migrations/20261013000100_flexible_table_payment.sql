-- Smart Group Tab — a table changes how it pays, both ways, and a diner at a tab
-- pays their part before the bill.
--
-- Changing to a tab while a round is in collection sends that round to the
-- kitchen through the same guarded transition every dispatch uses (I2). Never
-- while anyone is paying: a live hold anywhere at the table refuses the change,
-- so no payment lands on a round whose rules moved under it (I1).

drop function switch_to_tab(uuid, uuid);

/**
 * release_round_if_settled without the settlement test: only for a round whose
 * table just switched to a tab. The status guard and on-conflict-do-nothing are
 * the same, so this too dispatches a round at most once.
 */
create or replace function release_round_to_tab(p_round_id uuid)
returns boolean
language plpgsql
as $$
declare
  v_transitioned integer;
begin
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

create or replace function set_table_payment(p_session_id uuid, p_participant_id uuid, p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller     uuid := current_participant_id();
  v_session    sessions;
  v_round      rounds;
  v_dispatched uuid[] := '{}';
begin
  if v_caller is not null and v_caller <> p_participant_id then
    raise exception using errcode = 'insufficient_privilege',
      message = 'cannot change how the table pays on behalf of another participant';
  end if;
  if p_mode is null or p_mode not in ('pay_before_order', 'open_tab') then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_mode');
  end if;

  -- The lock close_round and reserve_tab take first.
  select * into v_session from sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_session');
  end if;
  if not exists (select 1 from participants where id = p_participant_id and session_id = p_session_id) then
    return jsonb_build_object('status', 'rejected', 'reason', 'participant_not_in_session');
  end if;
  if v_session.status = 'closed' then
    return jsonb_build_object('status', 'rejected', 'reason', 'session_closed');
  end if;
  if v_session.bill_requested_at is not null then
    return jsonb_build_object('status', 'rejected', 'reason', 'bill_requested');
  end if;
  if v_session.service_mode = 'hybrid' then
    return jsonb_build_object('status', 'rejected', 'reason', 'hybrid_table');
  end if;
  if v_session.service_mode::text = p_mode then
    return jsonb_build_object('status', 'unchanged', 'service_mode', p_mode);
  end if;
  if exists (select 1 from rounds where session_id = p_session_id and status = 'requires_staff_attention') then
    return jsonb_build_object('status', 'rejected', 'reason', 'round_needs_staff');
  end if;

  -- The lock reserve_contribution takes: no round hold can appear between the
  -- check below and the switch. Tab holds are covered by the session lock.
  perform 1 from rounds where session_id = p_session_id and status = 'locked_for_payment' for update;

  -- Someone in the middle of paying: a live (active, unexpired) hold on any share
  -- of the table. Confirmed reservations are paid shares, not someone paying.
  if exists (
    select 1
      from contribution_reservations cr
      join reservation_allocations ra on ra.reservation_id = cr.id
      join cart_item_shares s on s.id = ra.cart_item_share_id
      join rounds r on r.id = s.round_id
     where r.session_id = p_session_id
       and cr.status = 'active' and cr.expires_at > now()) then
    return jsonb_build_object('status', 'rejected', 'reason', 'someone_paying');
  end if;

  update sessions set service_mode = p_mode::service_mode where id = p_session_id;
  -- The round being built follows; rounds already in the kitchen keep their rule.
  update rounds set requires_prepayment = requires_prepayment(p_session_id, round_number)
   where session_id = p_session_id and status = 'draft';

  -- A round in collection goes to the kitchen; its unpaid shares are on the tab.
  if p_mode = 'open_tab' then
    for v_round in select * from rounds where session_id = p_session_id and status = 'locked_for_payment' loop
      update rounds set requires_prepayment = false where id = v_round.id;
      if release_round_to_tab(v_round.id) then
        v_dispatched := v_dispatched || v_round.id;
      end if;
    end loop;
  end if;

  return jsonb_build_object('status', 'changed', 'service_mode', p_mode, 'dispatched_rounds', to_jsonb(v_dispatched));
end;
$$;

create or replace function reserve_tab(p_session_id uuid, p_participant_id uuid, p_mode text, p_idempotency_key text, p_tip_amount bigint DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- Before the bill only a table running a tab may pay, and each diner only their
  -- own part: covering the rest is what asking for the bill is for.
  if v_session.bill_requested_at is null
     and (v_session.service_mode <> 'open_tab' or p_mode is distinct from 'my_items') then
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
$function$;

revoke all on function release_round_to_tab(uuid) from public, anon, authenticated;
revoke all on function set_table_payment(uuid, uuid, text) from public;
grant execute on function set_table_payment(uuid, uuid, text) to anon, authenticated;
