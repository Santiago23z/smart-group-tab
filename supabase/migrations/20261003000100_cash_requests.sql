-- Smart Group Tab — "voy a pagar en efectivo / con datáfono", from the app.
--
-- A request tells the waiter where to go; it moves no money and holds no
-- shares, so the diner can still pay in Wompi. Its amount is never stored: it
-- is whatever the part it names still has unpaid, so a request ends on its own
-- when that part is paid by any route, with no code in any payment path.

create table cash_requests (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references sessions (id) on delete cascade,
  participant_id uuid not null references participants (id) on delete cascade,
  scope          text not null check (scope in ('mine', 'rest')),
  method         manual_payment_method not null,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  resolution     text check (resolution in ('cancelled', 'dismissed', 'paid')),
  constraint cash_requests_resolution_matches check ((resolved_at is null) = (resolution is null))
);

-- One open request per diner.
create unique index cash_requests_one_open on cash_requests (participant_id) where resolved_at is null;

/**
 * What a request covers right now: once the bill was asked for, the tab;
 * otherwise the oldest round still collecting that has something unpaid for it.
 * `held` is the part someone is paying in Wompi at this moment.
 */
create or replace function cash_request_target(p_session_id uuid, p_participant_id uuid, p_scope text)
returns jsonb
language plpgsql
stable
as $$
declare
  v_bill  timestamptz;
  v_round uuid;
  v_out   jsonb;
begin
  select bill_requested_at into v_bill from sessions where id = p_session_id;

  if v_bill is not null then
    select jsonb_build_object('scope', 'tab', 'target_id', p_session_id,
             'amount', coalesce(sum(t.owed_amount), 0),
             'held', coalesce(sum(t.owed_amount) filter (where is_share_held(t.id)), 0))
      into v_out
      from session_tab_shares(p_session_id) t
     where p_scope = 'rest' or t.participant_id = p_participant_id;
    return v_out;
  end if;

  select r.id into v_round
    from rounds r
   where r.session_id = p_session_id and r.status = 'locked_for_payment'
     and exists (select 1 from active_shares(r.id) s
                  where not is_share_settled(s.id)
                    and (p_scope = 'rest' or s.participant_id = p_participant_id))
   order by r.round_number
   limit 1;

  if v_round is null then
    return jsonb_build_object('scope', null, 'target_id', null, 'amount', 0, 'held', 0);
  end if;

  select jsonb_build_object('scope', 'round', 'target_id', v_round,
           'amount', coalesce(sum(s.owed_amount), 0),
           'held', coalesce(sum(s.owed_amount) filter (where is_share_held(s.id)), 0))
    into v_out
    from active_shares(v_round) s
   where not is_share_settled(s.id)
     and (p_scope = 'rest' or s.participant_id = p_participant_id);
  return v_out;
end;
$$;

create or replace function request_cash_payment(p_session_id uuid, p_participant_id uuid, p_scope text, p_method text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := current_participant_id();
  v_target jsonb;
  v_id     uuid;
begin
  if v_caller is not null and v_caller <> p_participant_id then
    raise exception using errcode = 'insufficient_privilege',
      message = 'cannot ask on behalf of another participant';
  end if;
  if p_method is null or p_method not in ('cash', 'card_terminal') then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_method');
  end if;
  if p_scope is null or p_scope not in ('mine', 'rest') then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_scope');
  end if;
  if not exists (select 1 from participants where id = p_participant_id and session_id = p_session_id) then
    return jsonb_build_object('status', 'rejected', 'reason', 'participant_not_in_session');
  end if;

  v_target := cash_request_target(p_session_id, p_participant_id, p_scope);
  if (v_target ->> 'amount')::bigint = 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'nothing_to_pay');
  end if;

  -- A new request replaces the diner's open one.
  update cash_requests set resolved_at = now(), resolution = 'cancelled'
   where participant_id = p_participant_id and resolved_at is null;

  insert into cash_requests (session_id, participant_id, scope, method)
  values (p_session_id, p_participant_id, p_scope, p_method::manual_payment_method)
  returning id into v_id;

  return jsonb_build_object('status', 'requested', 'id', v_id, 'method', p_method,
                            'amount', (v_target ->> 'amount')::bigint);
end;
$$;

create or replace function cancel_cash_request(p_session_id uuid, p_participant_id uuid)
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
      message = 'cannot cancel on behalf of another participant';
  end if;
  update cash_requests set resolved_at = now(), resolution = 'cancelled'
   where session_id = p_session_id and participant_id = p_participant_id and resolved_at is null;
  return jsonb_build_object('status', 'cancelled');
end;
$$;

create or replace function staff_dismiss_cash_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session uuid;
begin
  update cash_requests set resolved_at = now(), resolution = 'dismissed'
   where id = p_request_id and resolved_at is null
  returning session_id into v_session;
  if v_session is null then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_request');
  end if;
  perform staff_log('dismiss_cash_request', p_request_id, v_session, '{}'::jsonb);
  return jsonb_build_object('status', 'dismissed');
end;
$$;

/** Open requests that still have something to collect, oldest first. */
create or replace function staff_cash_requests()
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(x.r order by x.created_at), '[]'::jsonb)
    from (
      select c.created_at, jsonb_build_object(
               'id', c.id, 'session_id', c.session_id, 'table', t.label,
               'participant_id', case when c.scope = 'mine' then c.participant_id end,
               'nickname', p.nickname, 'scope', c.scope, 'method', c.method,
               'created_at', c.created_at,
               'amount', (tg ->> 'amount')::bigint, 'held', (tg ->> 'held')::bigint,
               'target_scope', tg ->> 'scope', 'target_id', tg ->> 'target_id') as r,
             (tg ->> 'amount')::bigint as amount
        from cash_requests c
        join participants p on p.id = c.participant_id
        join sessions s on s.id = c.session_id
        join tables t on t.id = s.table_id
        cross join lateral cash_request_target(c.session_id, c.participant_id, c.scope) tg
       where c.resolved_at is null and s.status <> 'closed'
    ) x
   where x.amount > 0;
$$;

alter table cash_requests enable row level security;
revoke all on cash_requests from public, anon, authenticated;
revoke all on function cash_request_target(uuid, uuid, text), staff_dismiss_cash_request(uuid), staff_cash_requests()
  from public, anon, authenticated;
revoke all on function request_cash_payment(uuid, uuid, text, text), cancel_cash_request(uuid, uuid) from public;
grant execute on function request_cash_payment(uuid, uuid, text, text), cancel_cash_request(uuid, uuid)
  to anon, authenticated;
