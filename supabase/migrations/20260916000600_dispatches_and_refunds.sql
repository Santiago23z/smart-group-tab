-- Smart Group Tab — dispatch outbox and refund registry.

-- ---------------------------------------------------------------------------
-- I2 — Dispatch exactly once.
--
-- "The round reached 100%" is an event that WILL be observed many times: PSP
-- retries, Realtime reconnects, client refreshes. The state transition in
-- confirm_webhook is the primary guard; this unique constraint is the second belt.
--
-- The external call never happens inside the transaction. An HTTP failure there
-- would roll back a payment that already moved real money, and "exactly once"
-- would degrade to "sometimes zero" — paid food the kitchen never sees. The
-- transaction writes the row; a worker delivers it with backoff.
-- ---------------------------------------------------------------------------
create table dispatches (
  id              uuid primary key default gen_random_uuid(),
  round_id        uuid not null references rounds (id) on delete cascade,
  channel         dispatch_channel not null,
  status          dispatch_status not null default 'pending',
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,

  unique (round_id, channel),

  constraint dispatches_delivered_at_matches_status
    check ((status = 'delivered') = (delivered_at is not null))
);

-- The worker's claim query: pending rows whose backoff has elapsed.
create index dispatches_due_idx on dispatches (next_attempt_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- D17 — Refunds are recorded, not executed.
--
-- §7 of the strategy doc is right that reversal and refund states must be
-- modelled honestly: the reversal window depends on the payment method and the
-- provider, and the UI must not claim the money is back when the bank is still
-- processing. But the MVP does not call Wompi's refund API — a staff member
-- resolves it and records it here, so there is an audit trail over real money.
-- ---------------------------------------------------------------------------
create table refunds (
  id                         uuid primary key default gen_random_uuid(),
  contribution_id            uuid not null references contributions (id) on delete restrict,
  amount                     money_amount not null check (amount > 0),
  reason                     text not null check (length(btrim(reason)) > 0),
  status                     refund_status not null default 'pending',
  recorded_by_participant_id uuid references participants (id) on delete set null,
  -- Whatever the staff member can point at: a Nequi transfer id, a cash receipt
  -- number, a POS void reference.
  external_reference         text,
  created_at                 timestamptz not null default now(),
  completed_at               timestamptz,

  constraint refunds_completed_at_matches_status
    check ((status = 'completed') = (completed_at is not null))
);

create index refunds_contribution_idx on refunds (contribution_id);

-- A contribution cannot be refunded for more than it was worth.
create or replace function assert_refund_ceiling(p_contribution_id uuid)
returns void
language plpgsql
as $$
declare
  v_paid     bigint;
  v_refunded bigint;
begin
  select order_amount + tip_amount into v_paid
    from contributions
   where id = p_contribution_id;

  if not found then
    return;
  end if;

  select coalesce(sum(amount), 0) into v_refunded
    from refunds
   where contribution_id = p_contribution_id
     and status <> 'rejected';

  if v_refunded > v_paid then
    raise exception using
      errcode = 'integrity_constraint_violation',
      message = format(
        'refunds against contribution %s total %s, exceeding the %s that was paid',
        p_contribution_id, v_refunded, v_paid);
  end if;
end;
$$;

create or replace function tg_assert_refund_ceiling()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform assert_refund_ceiling(new.contribution_id);
  end if;
  if tg_op = 'UPDATE' and old.contribution_id <> new.contribution_id then
    perform assert_refund_ceiling(old.contribution_id);
  end if;
  return null;
end;
$$;

create constraint trigger refunds_ceiling
  after insert or update on refunds
  deferrable initially deferred
  for each row execute function tg_assert_refund_ceiling();
