-- Smart Group Tab — the diner chooses how the table pays.
--
-- The first diner at a free table picks: pay each round (pay_before_order) or
-- open a tab and pay at the end (open_tab). Later diners follow the table. A
-- table paying each round may switch to a tab while nothing is in collection.
-- Collection, holds and dispatch are untouched: only which rounds need
-- prepayment changes, and that is fixed per round as before.

-- ---------------------------------------------------------------------------
-- 1. Joining, with the opener's choice. One signature: old two-argument calls
--    resolve here through the default.
-- ---------------------------------------------------------------------------
drop function open_or_join_session(text, text);

create function open_or_join_session(p_qr_token text, p_nickname text, p_mode text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  -- Hybrid is not a diner's choice: nothing lets a table leave a deposit yet.
  if p_mode is not null and p_mode not in ('pay_before_order', 'open_tab') then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_mode');
  end if;

  -- Serializes the scan. Ten phones hitting one QR at the same instant must open
  -- one tab, not ten — and two different choices resolve to the first.
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
    -- The opener's choice, else the venue's mode; the rest is copied, not referenced.
    insert into sessions (table_id, venue_id, service_mode, tip_mode, reservation_ttl)
    values (v_table.id, v_table.venue_id,
            coalesce(p_mode::service_mode, v_venue.default_service_mode),
            v_venue.default_tip_mode, v_venue.reservation_ttl)
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
    -- false when a choice was sent but the table already had its own.
    'chose',           v_created and p_mode is not null,
    'venue_id',        v_table.venue_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. What the join screen may know before joining: free or open, and how an
--    open table pays. No session id, nickname, item or amount.
-- ---------------------------------------------------------------------------
create or replace function table_status(p_qr_token text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select jsonb_build_object(
              'status',       case when s.id is null then 'free' else 'open' end,
              'venue',        v.name,
              'service_mode', s.service_mode)
       from tables t
       join venues v on v.id = t.venue_id
       left join sessions s on s.table_id = t.id
                           and s.status in ('open', 'settling', 'requires_staff_attention')
      where t.qr_token = p_qr_token and t.is_active
      limit 1),
    jsonb_build_object('status', 'unknown'));
$$;

-- ---------------------------------------------------------------------------
-- 3. Paying each round → a tab. One way only, and never under a payment: the
--    session lock is the one close_round takes first, so no round can enter
--    collection between the check and the switch.
-- ---------------------------------------------------------------------------
create or replace function switch_to_tab(p_session_id uuid, p_participant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller  uuid := current_participant_id();
  v_session sessions;
begin
  if v_caller is not null and v_caller <> p_participant_id then
    raise exception using errcode = 'insufficient_privilege',
      message = 'cannot switch on behalf of another participant';
  end if;

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
  if v_session.service_mode <> 'pay_before_order' then
    return jsonb_build_object('status', 'rejected', 'reason', 'not_paying_each_round');
  end if;
  if exists (select 1 from rounds
              where session_id = p_session_id
                and status in ('locked_for_payment', 'requires_staff_attention')) then
    return jsonb_build_object('status', 'rejected', 'reason', 'round_in_collection');
  end if;

  update sessions set service_mode = 'open_tab' where id = p_session_id;
  -- The round being built follows; rounds already closed keep their rule, so
  -- the tab never charges again what was paid before the kitchen.
  update rounds set requires_prepayment = false
   where session_id = p_session_id and status = 'draft';

  return jsonb_build_object('status', 'switched', 'service_mode', 'open_tab');
end;
$$;

revoke all on function open_or_join_session(text, text, text), table_status(text), switch_to_tab(uuid, uuid)
  from public;
grant execute on function open_or_join_session(text, text, text), table_status(text), switch_to_tab(uuid, uuid)
  to anon, authenticated;
