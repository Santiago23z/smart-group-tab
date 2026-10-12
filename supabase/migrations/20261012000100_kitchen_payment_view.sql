-- Smart Group Tab — what the kitchen screen says about money.
--
-- Two reads, nothing written. Each ticket says whether its round is paid, as
-- a word: the cooks never see an amount. The top bar says what came in today.

/**
 * 'unpaid' while some active share is neither paid nor written off; 'paid'
 * once all are paid (or the prepaid balance paid the round); 'written_off'
 * when nothing is unpaid and staff wrote some of it off. Computed from the
 * ledger every time, so it cannot drift from it.
 */
create or replace function round_payment_state(p_round_id uuid)
returns text
language sql
stable
as $$
  select case
           when r.paid_from_balance then 'paid'
           when exists (
             select 1 from active_shares(p_round_id) s
              where not is_share_settled(s.id)
                and not exists (select 1 from write_off_shares w where w.cart_item_share_id = s.id))
             then 'unpaid'
           when exists (
             select 1 from active_shares(p_round_id) s
               join write_off_shares w on w.cart_item_share_id = s.id)
             then 'written_off'
           else 'paid'
         end
    from rounds r
   where r.id = p_round_id;
$$;

/**
 * Money received on one calendar day in Colombia, order and tip together,
 * including money that landed as table credit: it did arrive. Split by rail;
 * each part includes its tips, so the parts add up to the total. Refunds
 * completed that day are reported apart and never subtracted. A write-off
 * moves no money and is not here.
 */
create or replace function staff_takings(p_day date)
returns jsonb
language sql
stable
as $$
  with bounds as (
    select p_day::timestamp at time zone 'America/Bogota'       as lo,
           (p_day + 1)::timestamp at time zone 'America/Bogota' as hi
  ), paid as (
    select c.order_amount + c.tip_amount as amount,
           c.tip_amount                  as tip,
           case when e.provider = 'manual' then m.method::text else 'wompi' end as rail
      from contributions c
      join webhook_events e on e.id = c.webhook_event_id
      left join manual_payments m on m.webhook_event_id = c.webhook_event_id
      cross join bounds b
     where c.created_at >= b.lo and c.created_at < b.hi
  )
  select jsonb_build_object(
           'day',           p_day,
           'from',          (select lo from bounds),
           'to',            (select hi from bounds),
           'total',         coalesce(sum(amount), 0)::bigint,
           'wompi',         coalesce(sum(amount) filter (where rail = 'wompi'), 0)::bigint,
           'cash',          coalesce(sum(amount) filter (where rail = 'cash'), 0)::bigint,
           'card_terminal', coalesce(sum(amount) filter (where rail = 'card_terminal'), 0)::bigint,
           'tips',          coalesce(sum(tip), 0)::bigint,
           'refunded',      (select coalesce(sum(f.amount), 0)::bigint
                               from refunds f cross join bounds b
                              where f.status = 'completed'
                                and f.completed_at >= b.lo and f.completed_at < b.hi))
    from paid;
$$;

create or replace function staff_takings_today()
returns jsonb
language sql
stable
as $$
  select staff_takings((now() at time zone 'America/Bogota')::date);
$$;

revoke all on function round_payment_state(uuid), staff_takings(date), staff_takings_today()
  from public, anon, authenticated;
