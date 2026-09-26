-- Smart Group Tab — the kitchen display and staff alerts.
--
-- kitchen_tickets is the KDS's own record of what it received. It is NOT the
-- outbox: `dispatches` says the worker delivered, this says the kitchen has it.
-- Keeping them apart is what lets a restarted KDS still show every order the
-- worker already marked delivered — tickets held in memory would vanish while
-- the ledger claims they arrived.
--
-- Staff alerts are derived here, not in Node, for the same reason nothing else
-- decides anything in Node.

create table kitchen_tickets (
  -- The idempotency key. Only the `kds` channel is stored, so the round alone
  -- is the (round, channel) pair.
  round_id          uuid primary key references rounds (id) on delete cascade,
  ticket            jsonb not null,
  first_received_at timestamptz not null default now(),
  last_received_at  timestamptz not null default now(),
  receive_count     integer not null default 1 check (receive_count >= 1),
  done_at           timestamptz
);

create index kitchen_tickets_active_idx on kitchen_tickets (first_received_at)
  where done_at is null;

/**
 * Store a delivered ticket. A repeat bumps the counters and touches nothing
 * else: the stored ticket and done_at are never overwritten, so a re-delivery
 * after a crash shows one order and never reopens one already sent out.
 */
create or replace function kds_ingest(p_round_id uuid, p_ticket jsonb)
returns jsonb
language sql
as $$
  insert into kitchen_tickets (round_id, ticket)
  values (p_round_id, p_ticket)
  on conflict (round_id) do update
    set last_received_at = now(),
        receive_count    = kitchen_tickets.receive_count + 1
  returning jsonb_build_object(
    'status', case when receive_count = 1 then 'stored' else 'repeat' end,
    'receive_count', receive_count);
$$;

/** Idempotent. Touches the ticket only: never the round, session or dispatch. */
create or replace function kds_mark_done(p_round_id uuid)
returns jsonb
language sql
as $$
  update kitchen_tickets set done_at = coalesce(done_at, now())
   where round_id = p_round_id
  returning jsonb_build_object('status', 'done', 'done_at', done_at);
$$;

-- ---------------------------------------------------------------------------
-- Acknowledgement snapshots the reasons, not a time. `dispatches` has no
-- failure timestamp, and adding one to the worker's table for a UI concern is
-- backwards. An alert is acknowledged only while every current reason key is in
-- the snapshot, so a new incident at an acknowledged table shows up again.
-- ---------------------------------------------------------------------------
create table staff_alert_acks (
  session_id      uuid primary key references sessions (id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  reason_keys     text[] not null
);

/** One entry per reason for one session, each with a stable key. */
create or replace function staff_alert_reasons(p_session_id uuid)
returns jsonb
language sql
stable
as $$
  with money as (
    select c.id, c.order_amount + c.tip_amount as amount
      from contributions c
     where c.session_id = p_session_id
       and c.applied_to_prepaid_balance
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
       and not exists (select 1 from contributions c
                        where c.round_id = r.id and c.applied_to_prepaid_balance)
  ),
  reasons as (
    select 'contribution:' || id as key, jsonb_build_object(
             'kind', 'money_not_placed', 'amount', amount) as reason
      from money
    union all
    select 'dispatch:' || id, jsonb_build_object(
             'kind', 'delivery_failed', 'channel', channel,
             'round_number', round_number, 'error', last_error)
      from failed
    union all
    select 'round:' || id, jsonb_build_object(
             'kind', 'collection_stalled', 'round_number', round_number)
      from stalled
  )
  select coalesce(
           jsonb_agg(reason || jsonb_build_object('key', key) order by key),
           -- An alert that cannot explain itself is still an alert.
           jsonb_build_array(jsonb_build_object('kind', 'unknown', 'key', 'unknown')))
    from reasons;
$$;

/**
 * Everything the staff panel shows. `p_stall`: how long a due, pending dispatch
 * may wait before the queue counts as not being drained. Counted from
 * next_attempt_at, not created_at, so rows waiting out their backoff do not
 * count — they are not late, they are scheduled.
 */
create or replace function staff_alerts(p_stall interval)
returns jsonb
language sql
stable
as $$
  with alerting as (
    select s.id, t.label, staff_alert_reasons(s.id) as reasons
      from sessions s
      join tables t on t.id = s.table_id
     where s.status = 'requires_staff_attention'
  )
  select jsonb_build_object(
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object(
               'session_id', a.id,
               'table', a.label,
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

/** Acknowledge what is wrong right now. Changes no session, round or money. */
create or replace function acknowledge_alert(p_session_id uuid)
returns jsonb
language sql
as $$
  insert into staff_alert_acks (session_id, reason_keys)
  values (p_session_id, array(
    select r ->> 'key' from jsonb_array_elements(staff_alert_reasons(p_session_id)) r))
  on conflict (session_id) do update
    set acknowledged_at = now(), reason_keys = excluded.reason_keys
  returning jsonb_build_object('status', 'acknowledged', 'acknowledged_at', acknowledged_at);
$$;

-- The KDS connects as the owner, like the worker. Clients have no business here.
alter table kitchen_tickets enable row level security;
alter table staff_alert_acks enable row level security;
revoke all on kitchen_tickets, staff_alert_acks from public, anon, authenticated;
revoke all on function kds_ingest(uuid, jsonb), kds_mark_done(uuid),
  staff_alert_reasons(uuid), staff_alerts(interval), acknowledge_alert(uuid)
  from public, anon, authenticated;
