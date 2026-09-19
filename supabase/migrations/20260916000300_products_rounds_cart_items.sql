-- Smart Group Tab — menu, rounds, and cart items.

create table products (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues (id) on delete cascade,
  name         text not null,
  category     text,
  unit_price   money_amount not null check (unit_price > 0),
  -- D10: tax lives in the item subtotal. Tip never does.
  tax_rate     numeric(6, 5) not null default 0
                 check (tax_rate >= 0 and tax_rate < 1),
  is_available boolean not null default true,
  created_at   timestamptz not null default now()
);

create index products_venue_idx on products (venue_id) where is_available;

create table rounds (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null references sessions (id) on delete cascade,
  round_number        integer not null check (round_number > 0),
  status              round_status not null default 'draft',
  -- Resolved from the session's snapshotted service_mode at creation time, so
  -- the rule that governs this round is fixed even if anything upstream moves.
  requires_prepayment boolean not null,
  created_at          timestamptz not null default now(),
  closed_at           timestamptz,
  dispatched_at       timestamptz,

  unique (session_id, round_number),

  constraint rounds_dispatched_at_matches_status
    check ((status = 'paid_and_dispatched') = (dispatched_at is not null))
);

-- D11: exactly one open cart per session. Items added while an earlier round is
-- in collection overflow into this one rather than mutating a frozen total.
create unique index rounds_one_draft_per_session
  on rounds (session_id)
  where status = 'draft';

create index rounds_session_idx on rounds (session_id, round_number);

create table cart_items (
  id                      uuid primary key default gen_random_uuid(),
  round_id                uuid not null references rounds (id) on delete cascade,
  product_id              uuid not null references products (id) on delete restrict,
  quantity                integer not null check (quantity > 0),

  -- SNAPSHOT 2. Copied from products at insert time. Without this, a menu price
  -- change mid-service mutates the total of a round that is already in
  -- collection, invalidating every live reservation against it.
  unit_price              money_amount not null check (unit_price > 0),
  tax_rate                numeric(6, 5) not null
                            check (tax_rate >= 0 and tax_rate < 1),

  -- Generated columns cannot reference other generated columns, hence the
  -- repeated expression. line_total is the authority that shares must sum to (I1a).
  line_subtotal           bigint generated always as
                            (unit_price::bigint * quantity) stored,
  line_tax                bigint generated always as
                            (round(unit_price::numeric * quantity * tax_rate)::bigint) stored,
  line_total              bigint generated always as
                            (unit_price::bigint * quantity
                             + round(unit_price::numeric * quantity * tax_rate)::bigint) stored,

  added_by_participant_id uuid not null references participants (id) on delete restrict,
  status                  cart_item_status not null default 'active',
  created_at              timestamptz not null default now(),
  voided_at               timestamptz,

  -- D18: voiding is the only mutation allowed, and only while the round is draft.
  -- The round-state half of that rule is enforced in the void RPC; this is the
  -- column-level half.
  constraint cart_items_voided_at_matches_status
    check ((status = 'voided') = (voided_at is not null))
);

create index cart_items_round_idx on cart_items (round_id) where status = 'active';
create index cart_items_participant_idx on cart_items (added_by_participant_id);
