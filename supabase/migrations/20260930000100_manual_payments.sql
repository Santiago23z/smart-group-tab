-- Smart Group Tab — money received outside Wompi: cash and the card terminal.
--
-- Not a second way to write the ledger. A manual payment reserves exactly the
-- free shares it covers and settles them through confirm_webhook, with provider
-- 'manual' instead of 'wompi' — so shares are paid once, the round is released
-- once and the table closes by the same rules a Wompi payment already passes,
-- and "every contribution names an event" still holds. manual_payments is the
-- human-readable record of how the money came in.

create type manual_payment_method as enum ('cash', 'card_terminal');

create table manual_payments (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references sessions (id) on delete restrict,
  round_id         uuid references rounds (id) on delete restrict,  -- null for a tab
  participant_id   uuid not null references participants (id) on delete restrict,
  reservation_id   uuid not null unique references contribution_reservations (id) on delete restrict,
  webhook_event_id uuid not null unique references webhook_events (id) on delete restrict,
  method           manual_payment_method not null,
  amount           money_amount not null check (amount > 0),
  tip              money_amount not null default 0,
  reference        text,
  created_at       timestamptz not null default now()
);

create index manual_payments_session_idx on manual_payments (session_id, created_at);

create trigger manual_payments_append_only
  before update or delete on manual_payments
  for each row execute function tg_forbid_mutation();

/**
 * Who pays "the rest": the table's cashier, a staff participant. Equal splits
 * only use guests, so it never receives shares and never owes anything.
 */
create or replace function session_caja(p_session_id uuid)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  select id into v_id from participants
   where session_id = p_session_id and kind = 'staff' and nickname in ('Caja', 'Caja (local)')
   order by joined_at limit 1;
  if found then
    return v_id;
  end if;

  insert into participants (session_id, nickname, kind)
  values (p_session_id, 'Caja', 'staff')
      on conflict (session_id, nickname) do nothing
  returning id into v_id;

  -- A guest already called themselves "Caja".
  if v_id is null then
    insert into participants (session_id, nickname, kind)
    values (p_session_id, 'Caja (local)', 'staff')
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

/**
 * Staff received money in hand. The amount is never typed: it is whatever the
 * chosen part (one participant's free shares, or every free share) adds up to,
 * plus the tip — so cash cannot over- or under-collect, and cannot take shares
 * a diner is paying in Wompi right now.
 */
create or replace function staff_record_manual_payment(
  p_scope          text,    -- 'round' or 'tab'
  p_target_id      uuid,    -- the round, or the session
  p_participant_id uuid,    -- whose part; null for everything still unpaid
  p_method         text,
  p_reference      text default null,
  p_tip            bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id  uuid;
  v_payer       uuid;
  v_mode        text;
  v_claim       jsonb;
  v_event       text := 'manual-' || gen_random_uuid();
  v_reference   text := nullif(btrim(coalesce(p_reference, '')), '');
  v_settled     jsonb;
  v_event_row   uuid;
  v_payment     uuid;
begin
  if p_method is null or p_method not in ('cash', 'card_terminal') then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_method');
  end if;
  if coalesce(p_tip, 0) < 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_tip');
  end if;

  if p_scope = 'round' then
    select session_id into v_session_id from rounds where id = p_target_id;
    if not found then
      return jsonb_build_object('status', 'rejected', 'reason', 'unknown_round');
    end if;
  elsif p_scope = 'tab' then
    select id into v_session_id from sessions where id = p_target_id;
    if not found then
      return jsonb_build_object('status', 'rejected', 'reason', 'unknown_session');
    end if;
  else
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_scope');
  end if;

  if p_participant_id is null then
    v_payer := session_caja(v_session_id);
    v_mode := 'remaining';
  else
    if not exists (select 1 from participants where id = p_participant_id and session_id = v_session_id) then
      return jsonb_build_object('status', 'rejected', 'reason', 'participant_not_in_session');
    end if;
    v_payer := p_participant_id;
    v_mode := 'my_items';
  end if;

  -- The same holds a diner's phone takes, with every rule they enforce.
  if p_scope = 'round' then
    v_claim := reserve_contribution(p_target_id, v_payer, v_mode::split_mode, v_event, null, null,
                                    coalesce(p_tip, 0));
  else
    v_claim := reserve_tab(v_session_id, v_payer, v_mode, v_event, coalesce(p_tip, 0));
  end if;
  if v_claim ->> 'status' <> 'reserved' then
    return jsonb_build_object('status', 'rejected', 'reason', v_claim ->> 'reason');
  end if;

  -- ...and the same settlement a Wompi approval gets.
  v_settled := confirm_webhook(
    'manual', v_event, v_claim ->> 'psp_reference', 'approved',
    (v_claim ->> 'order_amount')::bigint + (v_claim ->> 'tip_amount')::bigint,
    jsonb_build_object('source', 'staff', 'method', p_method, 'reference', v_reference),
    true);
  if v_settled ->> 'status' <> 'settled' then
    -- Unreachable: the shares were reserved a moment ago in this transaction.
    raise exception 'manual payment did not settle: %', v_settled;
  end if;

  select id into v_event_row from webhook_events where provider = 'manual' and event_id = v_event;

  insert into manual_payments
    (session_id, round_id, participant_id, reservation_id, webhook_event_id, method, amount, tip, reference)
  values (v_session_id, case when p_scope = 'round' then p_target_id end, v_payer,
          (v_claim ->> 'reservation_id')::uuid, v_event_row, p_method::manual_payment_method,
          (v_claim ->> 'order_amount')::bigint, (v_claim ->> 'tip_amount')::bigint, v_reference)
  returning id into v_payment;

  perform staff_log('manual_payment', v_payment, v_session_id, jsonb_build_object(
    'method', p_method, 'scope', p_scope, 'participant_id', v_payer,
    'amount', (v_claim ->> 'order_amount')::bigint, 'tip', (v_claim ->> 'tip_amount')::bigint));

  return jsonb_build_object(
    'status', 'recorded', 'manual_payment_id', v_payment,
    'amount', (v_claim ->> 'order_amount')::bigint, 'tip', (v_claim ->> 'tip_amount')::bigint,
    'dispatched', coalesce((v_settled ->> 'dispatched')::boolean, false),
    'session_closed', (select status = 'closed' from sessions where id = v_session_id));
end;
$$;

-- "Cobros abiertos" gains each person's free part, for the cash dialog.
create or replace function staff_collections()
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'round_id',     r.id,
           'session_id',   r.session_id,
           'table',        t.label,
           'round_number', r.round_number,
           'status',       r.status,
           'total',        round_total(r.id),
           -- Not yet paid, held or not: what staff mean by "what's missing".
           -- round_outstanding() is narrower — only what nobody holds.
           'outstanding',  (select coalesce(sum(a.owed_amount), 0)
                              from active_shares(r.id) a
                             where not is_share_settled(a.id)),
           'unclaimed',    round_outstanding(r.id),
           -- What each person could still pay right now (not paid, not held):
           -- the choices "Cobrar en caja" offers.
           'parts', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'participant_id', p.id, 'nickname', p.nickname, 'free', x.free)
                    order by p.joined_at, p.nickname), '[]'::jsonb)
               from (select f.participant_id, sum(f.owed_amount) as free
                       from free_shares(r.id) f group by f.participant_id) x
               join participants p on p.id = x.participant_id),
           'reservations', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'id',         cr.id,
                      'nickname',   p.nickname,
                      'amount',     cr.order_amount + cr.tip_amount,
                      'expires_at', cr.expires_at)
                    order by cr.expires_at), '[]'::jsonb)
               from contribution_reservations cr
               join participants p on p.id = cr.participant_id
              where cr.round_id = r.id
                and cr.status = 'active'
                and cr.expires_at > now()))
         order by t.label, r.round_number), '[]'::jsonb)
    from rounds r
    join sessions s on s.id = r.session_id
    join tables t on t.id = s.table_id
   where r.status in ('locked_for_payment', 'requires_staff_attention');
$$;

alter table manual_payments enable row level security;
revoke all on manual_payments from public, anon, authenticated;
revoke all on function session_caja(uuid),
                       staff_record_manual_payment(text, uuid, uuid, text, text, bigint),
                       staff_collections()
  from public, anon, authenticated;
