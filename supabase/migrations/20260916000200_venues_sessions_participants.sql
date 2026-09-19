-- Smart Group Tab — venues, tables, sessions, participants.

create table venues (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  currency             char(3) not null default 'COP',
  default_service_mode service_mode not null default 'pay_before_order',
  default_tip_mode     tip_mode not null default 'individual',
  -- D8: reservation TTL. 5 minutes is the tuned default — long enough to open
  -- Nequi and approve, short enough that an abandoned checkout does not hold the
  -- table hostage.
  reservation_ttl      interval not null default interval '5 minutes',
  created_at           timestamptz not null default now(),

  constraint venues_reservation_ttl_sane
    check (reservation_ttl between interval '1 minute' and interval '30 minutes')
);

create table tables (
  id         uuid primary key default gen_random_uuid(),
  venue_id   uuid not null references venues (id) on delete cascade,
  label      text not null,
  -- D9: the QR encodes this token. Scanning it is the entire onboarding.
  qr_token   text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),

  unique (venue_id, label)
);

create index tables_venue_idx on tables (venue_id);

create table sessions (
  id              uuid primary key default gen_random_uuid(),
  table_id        uuid not null references tables (id) on delete restrict,
  -- Denormalised from tables so RLS and reporting do not need a join.
  venue_id        uuid not null references venues (id) on delete restrict,

  -- SNAPSHOT 1 (D6). Copied from the venue when the session opens. A venue that
  -- flips its configuration at 11pm must not mutate tables that are mid-service;
  -- they finish their cycle under the rules they opened with.
  service_mode    service_mode not null,
  tip_mode        tip_mode not null,
  reservation_ttl interval not null,

  status          session_status not null default 'open',

  -- D14: funds the table holds in advance. Consumed and topped up by rounds 2+
  -- under 'hybrid', and the landing place for overpayments (I3) and for staff
  -- resolutions of stalled rounds (D2).
  prepaid_balance money_amount not null default 0,

  opened_at       timestamptz not null default now(),
  closed_at       timestamptz,

  constraint sessions_closed_at_matches_status
    check ((status = 'closed') = (closed_at is not null))
);

-- A physical table hosts at most one live session at a time.
create unique index sessions_one_live_per_table
  on sessions (table_id)
  where status in ('open', 'settling', 'needs_staff_attention');

create index sessions_venue_idx on sessions (venue_id, status);

create table participants (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions (id) on delete cascade,
  -- D9: nickname only. No account, no email, no verification.
  nickname   text not null check (length(btrim(nickname)) between 1 and 40),
  -- §9 of the strategy doc: staff keep adding orders alongside guests.
  kind       participant_kind not null default 'guest',
  joined_at  timestamptz not null default now(),

  unique (session_id, nickname)
);

create index participants_session_idx on participants (session_id);
