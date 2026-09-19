-- Smart Group Tab — domain types, money domain, and role bootstrap.
--
-- Money is always stored as bigint in the currency's minor unit. Never float,
-- never numeric-with-rounding: every amount in this schema is an exact integer
-- and every split preserves the sum exactly (invariant I1a).

-- gen_random_uuid() is core since Postgres 13, so pgcrypto is not required.

-- Supabase provides these roles; plain Postgres does not. Create them when
-- missing so the same migrations run in both environments.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create domain money_amount as bigint
  check (value >= 0);

-- Operating modality of a venue. Snapshotted onto sessions at open time (D6).
create type service_mode as enum ('pay_before_order', 'open_tab', 'hybrid');

-- Only 'individual' is implemented in the MVP; 'proportional' is modelled so the
-- schema does not need a migration when it ships.
create type tip_mode as enum ('individual', 'proportional');

create type session_status as enum (
  'open',
  'settling',
  'needs_staff_attention',
  'closed'
);

create type round_status as enum (
  'draft',                 -- cart is mutable, items can be added and voided
  'pending_payment',       -- cart frozen (D11), shares claimable
  'paid_and_dispatched',   -- terminal success; fired to kitchen exactly once (I2)
  'needs_staff_attention', -- stalled collection or unexpected overpayment (D2)
  'cancelled'
);

create type cart_item_status as enum ('active', 'voided');

create type participant_kind as enum ('guest', 'staff');

create type reservation_status as enum (
  'active',     -- holding shares until expires_at
  'confirmed',  -- payment settled, shares permanently claimed
  'expired',    -- housekeeping only; expiry is evaluated lazily, not by this value
  'cancelled'   -- payment declined or released by staff
);

create type dispatch_channel as enum ('kds', 'print');

create type dispatch_status as enum ('pending', 'delivered', 'failed');

-- D17: refunds are recorded for audit, not executed through the PSP API.
create type refund_status as enum ('pending', 'completed', 'rejected');
