-- Smart Group Tab — who at an open table has owed for too long.
--
-- A warning, not a flag: it never changes a session's state, and it lives apart
-- from staff_alert_reasons so it can never keep a flagged session flagged
-- (staff_resolve_if_clear reads only that function).

-- ---------------------------------------------------------------------------
-- 1. The tab says, per person, since when their oldest unpaid dish has been in
--    the kitchen.
-- ---------------------------------------------------------------------------
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
               'held',           x.held,
               'unpaid_since',   x.unpaid_since)
             order by p.joined_at), '[]'::jsonb)
        from (select tab.participant_id, sum(tab.owed_amount) as unpaid,
                     coalesce(sum(tab.owed_amount) filter (where is_share_held(tab.id)), 0) as held,
                     min(r.dispatched_at) as unpaid_since
                from tab join rounds r on r.id = tab.round_id
               group by tab.participant_id) x
        join participants p on p.id = x.participant_id));
$$;

-- ---------------------------------------------------------------------------
-- 2. One reason per person past the threshold, keyed by person: someone new
--    crossing it un-acknowledges the table; the same person staying past it
--    does not.
-- ---------------------------------------------------------------------------
create or replace function staff_unpaid_reasons(p_session_id uuid, p_threshold interval)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind',           'tab_unpaid_long',
           'key',            'tab_unpaid:' || x.participant_id,
           'participant_id', x.participant_id,
           'nickname',       p.nickname,
           'unpaid',         x.unpaid,
           'unpaid_since',   x.unpaid_since)
         order by x.unpaid_since), '[]'::jsonb)
    from (select t.participant_id, sum(t.owed_amount) as unpaid, min(r.dispatched_at) as unpaid_since
            from session_tab_shares(p_session_id) t
            join rounds r on r.id = t.round_id
           group by t.participant_id) x
    join participants p on p.id = x.participant_id
   where x.unpaid > 0
     and x.unpaid_since < now() - p_threshold;
$$;

-- ---------------------------------------------------------------------------
-- 3. The alert list: flagged tables as before, plus open tables where someone
--    has owed too long. A cheap pre-filter keeps the tab computation to tables
--    with a round in the kitchen older than the threshold.
-- ---------------------------------------------------------------------------
drop function staff_alerts(interval);

create function staff_alerts(p_stall interval, p_unpaid interval default interval '90 minutes')
returns jsonb
language sql
stable
as $$
  with alerting as (
    select s.id, t.label, s.prepaid_balance,
           -- staff_alert_reasons answers "unknown" for a healthy session, so it is asked
           -- only of sessions it is meant for: flagged ones, and closed ones holding money.
           case when s.status in ('requires_staff_attention', 'closed') then staff_alert_reasons(s.id)
                else '[]'::jsonb end
           || staff_unpaid_reasons(s.id, p_unpaid) as reasons
      from sessions s
      join tables t on t.id = s.table_id
     where s.status = 'requires_staff_attention'
        -- A table that already closed cannot be flagged — its QR may be seating
        -- the next party — but late money on it still needs a human.
        or (s.status = 'closed'
            and exists (select 1 from jsonb_array_elements(staff_alert_reasons(s.id)) r
                         where r ->> 'kind' = 'money_not_placed'))
        or (s.status <> 'closed'
            and exists (select 1 from rounds r
                         where r.session_id = s.id
                           and r.status = 'paid_and_dispatched'
                           and not r.requires_prepayment
                           and r.dispatched_at < now() - p_unpaid)
            and jsonb_array_length(staff_unpaid_reasons(s.id, p_unpaid)) > 0)
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
-- 4. "Visto" covers the unpaid reasons shown at that moment too.
-- ---------------------------------------------------------------------------
drop function acknowledge_alert(uuid);

create function acknowledge_alert(p_session_id uuid, p_unpaid interval default interval '90 minutes')
returns jsonb
language sql
as $$
  insert into staff_alert_acks (session_id, reason_keys)
  values (p_session_id, array(
    select r ->> 'key'
      from jsonb_array_elements(
             (select case when status in ('requires_staff_attention', 'closed')
                          then staff_alert_reasons(p_session_id) else '[]'::jsonb end
                from sessions where id = p_session_id)
             || staff_unpaid_reasons(p_session_id, p_unpaid)) r))
  on conflict (session_id) do update
    set acknowledged_at = now(), reason_keys = excluded.reason_keys
  returning jsonb_build_object('status', 'acknowledged', 'acknowledged_at', acknowledged_at);
$$;

revoke all on function staff_unpaid_reasons(uuid, interval), staff_alerts(interval, interval),
  acknowledge_alert(uuid, interval)
  from public, anon, authenticated;
