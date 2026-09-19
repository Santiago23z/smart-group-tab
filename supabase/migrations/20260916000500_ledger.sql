-- Smart Group Tab — the ledger: webhook events, reservations, allocations, contributions.

-- ---------------------------------------------------------------------------
-- D7 — Idempotency gate.
--
-- The ledger is reconstructible from PSP webhooks and from nothing else. Client
-- callbacks are never trusted: in a nightclub the phone loses signal on the way
-- back from the gateway, and that must not cost anyone money.
-- ---------------------------------------------------------------------------
create table webhook_events (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null default 'wompi',
  -- The PSP's own event identifier. Inserting it is the gate: a retry collides
  -- here and the handler exits before touching the ledger.
  event_id           text not null,
  payload            jsonb not null,
  signature_verified boolean not null default false,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,

  unique (provider, event_id)
);

create index webhook_events_unprocessed_idx on webhook_events (received_at)
  where processed_at is null;

-- ---------------------------------------------------------------------------
-- The atomic claim (D1, D16).
--
-- With an irreversible push rail there is no auth/capture, so the claim must
-- happen BEFORE the user is sent to the gateway. Validating without holding does
-- not prevent the race, it only narrows the window: two people read the same
-- remaining balance 2 seconds apart, both pay, and the second one's money is
-- gone against a round that is already complete.
-- ---------------------------------------------------------------------------
create table contribution_reservations (
  id              uuid primary key default gen_random_uuid(),
  round_id        uuid not null references rounds (id) on delete restrict,
  participant_id  uuid not null references participants (id) on delete restrict,

  -- Denormalised sum of this reservation's allocations. Kept in step by the
  -- reservation RPC and verified by the trigger below.
  order_amount    money_amount not null check (order_amount > 0),
  -- D10: the tip rides along with the payment but never counts toward round
  -- completion. Lumping it in means firing food that is only partly paid for.
  tip_amount      money_amount not null default 0,

  status          reservation_status not null default 'active',

  -- Caller-supplied. A double submit from the same device returns the existing
  -- reservation instead of claiming a second set of shares.
  idempotency_key text not null unique,
  -- What the PSP echoes back on the webhook.
  psp_reference   text not null unique,

  -- D8: expiry is evaluated lazily, by comparing this column at read time. A
  -- pg_cron job flips stale rows to 'expired' for hygiene and reporting only —
  -- if correctness depended on the cron, a late cron would be overcollection.
  expires_at      timestamptz not null,

  created_at      timestamptz not null default now(),
  settled_at      timestamptz
);

create index contribution_reservations_round_idx
  on contribution_reservations (round_id, status);
create index contribution_reservations_live_idx
  on contribution_reservations (expires_at)
  where status = 'active';

-- Which shares this reservation holds. The row's existence under a live
-- reservation is what makes a share unavailable (I1b).
create table reservation_allocations (
  id                 uuid primary key default gen_random_uuid(),
  reservation_id     uuid not null
                       references contribution_reservations (id) on delete cascade,
  cart_item_share_id uuid not null
                       references cart_item_shares (id) on delete restrict,
  amount             money_amount not null check (amount > 0),

  unique (reservation_id, cart_item_share_id)
);

create index reservation_allocations_share_idx
  on reservation_allocations (cart_item_share_id);

-- Note on why there is no partial unique index over cart_item_share_id here:
-- the predicate would need to read "belongs to a reservation that is confirmed,
-- or active and not yet expired", and a partial index predicate must be
-- IMMUTABLE — now() is not. Mutual exclusion comes instead from the round row
-- lock that every money RPC takes first. See 20260916000700_policies.sql.

-- ---------------------------------------------------------------------------
-- The ledger proper. Append-only, no exceptions.
-- ---------------------------------------------------------------------------
create table contributions (
  id                          uuid primary key default gen_random_uuid(),
  reservation_id              uuid not null unique
                                references contribution_reservations (id) on delete restrict,
  round_id                    uuid not null references rounds (id) on delete restrict,
  session_id                  uuid not null references sessions (id) on delete restrict,
  participant_id              uuid not null references participants (id) on delete restrict,

  order_amount                money_amount not null check (order_amount > 0),
  tip_amount                  money_amount not null default 0,

  webhook_event_id            uuid not null references webhook_events (id) on delete restrict,

  -- I3: set when an approved webhook arrives against a reservation whose shares
  -- were already retaken. The money moved for real, so it is never rejected — it
  -- lands in sessions.prepaid_balance and the round goes to staff (D2).
  applied_to_prepaid_balance  boolean not null default false,

  created_at                  timestamptz not null default now()
);

create index contributions_round_idx on contributions (round_id);
create index contributions_session_idx on contributions (session_id);
create index contributions_participant_idx on contributions (participant_id);

create or replace function tg_forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = 'integrity_constraint_violation',
    message = format('%s is append-only; %s is not permitted', tg_table_name, tg_op);
end;
$$;

create trigger contributions_append_only
  before update or delete on contributions
  for each row execute function tg_forbid_mutation();

-- ---------------------------------------------------------------------------
-- The denormalised order_amount must equal the allocations it claims to cover.
-- Deferred, because a reservation and its allocations are separate statements.
-- ---------------------------------------------------------------------------
create or replace function assert_reservation_allocation_sum(p_reservation_id uuid)
returns void
language plpgsql
as $$
declare
  v_order_amount bigint;
  v_allocated    bigint;
begin
  select order_amount into v_order_amount
    from contribution_reservations
   where id = p_reservation_id;

  if not found then
    return;
  end if;

  select coalesce(sum(amount), 0) into v_allocated
    from reservation_allocations
   where reservation_id = p_reservation_id;

  if v_allocated <> v_order_amount then
    raise exception using
      errcode = 'integrity_constraint_violation',
      message = format(
        'reservation %s declares order_amount %s but allocates %s',
        p_reservation_id, v_order_amount, v_allocated);
  end if;
end;
$$;

-- One trigger function per table, deliberately. A single shared function cannot
-- work here: plpgsql resolves every field reference against the record at parse
-- time, so `case tg_table_name when ... then new.reservation_id else new.id end`
-- fails on contribution_reservations, which has no reservation_id column — the
-- untaken branch is still resolved.
create or replace function tg_allocations_sum()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform assert_reservation_allocation_sum(new.reservation_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    perform assert_reservation_allocation_sum(old.reservation_id);
  end if;
  return null;
end;
$$;

create or replace function tg_reservation_sum()
returns trigger
language plpgsql
as $$
begin
  perform assert_reservation_allocation_sum(new.id);
  return null;
end;
$$;

create constraint trigger reservation_allocations_sum
  after insert or update or delete on reservation_allocations
  deferrable initially deferred
  for each row execute function tg_allocations_sum();

create constraint trigger contribution_reservations_allocation_sum
  after insert or update on contribution_reservations
  deferrable initially deferred
  for each row execute function tg_reservation_sum();
