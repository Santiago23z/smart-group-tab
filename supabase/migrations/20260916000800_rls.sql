-- Smart Group Tab — row level security.
--
-- The rule is uniform and deliberately blunt: **clients never write.** Every
-- table below is read-only to anon and authenticated; every mutation goes
-- through a SECURITY DEFINER RPC that starts by locking the round.
--
-- This is not belt-and-braces, it is load-bearing. Mutual exclusion over shares
-- comes from that row lock and from nothing else (a partial unique index cannot
-- express lazy expiry, because its predicate must be IMMUTABLE and now() is not).
-- A client that could INSERT directly would bypass the only serialization point
-- in the system.
--
-- It also falls out of I1a: a cart_item without its shares violates conservation
-- at commit, so inserting one is only possible alongside its shares — i.e. inside
-- a function that knows how to build both.

create or replace function current_staff_venue_id()
returns uuid
language plpgsql
stable
as $$
declare
  v_raw text;
begin
  begin
    v_raw := nullif(current_setting('request.jwt.claims', true), '')::jsonb
               ->> 'staff_venue_id';
  exception when others then
    v_raw := null;
  end;

  if v_raw is null then
    v_raw := nullif(current_setting('app.staff_venue_id', true), '');
  end if;

  return v_raw::uuid;
exception when others then
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'venues', 'tables', 'sessions', 'participants', 'products', 'rounds',
    'cart_items', 'cart_item_shares', 'contribution_reservations',
    'reservation_allocations', 'contributions', 'webhook_events',
    'dispatches', 'refunds'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    -- No INSERT/UPDATE/DELETE policy is ever created for these roles, and a
    -- table with RLS enabled and no matching policy denies by default.
    execute format('grant select on %I to anon, authenticated', t);
  end loop;
end $$;

grant execute on function
  current_participant_id(), current_session_id(), current_staff_venue_id(),
  round_total(uuid), round_outstanding(uuid), round_is_fully_settled(uuid),
  active_shares(uuid), free_shares(uuid),
  is_share_held(uuid), is_share_settled(uuid),
  requires_prepayment(uuid, integer), allocate_evenly(bigint, integer)
to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Guest reads: scoped to the session the participant belongs to.
--
-- Everyone at the table sees the whole table — who ordered what, what is still
-- outstanding, who has paid. That shared view is the product.
-- ---------------------------------------------------------------------------

create policy sessions_read_own on sessions for select
  using (id = current_session_id() or venue_id = current_staff_venue_id());

create policy participants_read_tablemates on participants for select
  using (session_id = current_session_id()
         or session_id in (select id from sessions where venue_id = current_staff_venue_id()));

create policy venues_read_own on venues for select
  using (id = current_staff_venue_id()
         or id in (select venue_id from sessions where id = current_session_id()));

create policy tables_read_own on tables for select
  using (venue_id = current_staff_venue_id()
         or id in (select table_id from sessions where id = current_session_id()));

-- The menu is visible to anyone seated in the venue, and to staff.
create policy products_read_venue on products for select
  using (venue_id = current_staff_venue_id()
         or venue_id in (select venue_id from sessions where id = current_session_id()));

create policy rounds_read_own on rounds for select
  using (session_id = current_session_id()
         or session_id in (select id from sessions where venue_id = current_staff_venue_id()));

create policy cart_items_read_own on cart_items for select
  using (round_id in (
    select id from rounds
     where session_id = current_session_id()
        or session_id in (select id from sessions where venue_id = current_staff_venue_id())));

create policy cart_item_shares_read_own on cart_item_shares for select
  using (round_id in (
    select id from rounds
     where session_id = current_session_id()
        or session_id in (select id from sessions where venue_id = current_staff_venue_id())));

create policy reservations_read_own on contribution_reservations for select
  using (round_id in (
    select id from rounds
     where session_id = current_session_id()
        or session_id in (select id from sessions where venue_id = current_staff_venue_id())));

create policy allocations_read_own on reservation_allocations for select
  using (reservation_id in (
    select r.id from contribution_reservations r
      join rounds rd on rd.id = r.round_id
     where rd.session_id = current_session_id()
        or rd.session_id in (select id from sessions where venue_id = current_staff_venue_id())));

create policy contributions_read_own on contributions for select
  using (session_id = current_session_id()
         or session_id in (select id from sessions where venue_id = current_staff_venue_id()));

-- ---------------------------------------------------------------------------
-- Staff-only reads. A guest has no business seeing either of these.
-- ---------------------------------------------------------------------------

create policy dispatches_read_staff on dispatches for select
  using (round_id in (
    select rd.id from rounds rd
      join sessions s on s.id = rd.session_id
     where s.venue_id = current_staff_venue_id()));

create policy refunds_read_staff on refunds for select
  using (contribution_id in (
    select c.id from contributions c
      join sessions s on s.id = c.session_id
     where s.venue_id = current_staff_venue_id()));

-- webhook_events gets no policy at all: raw PSP payloads are service_role only.
revoke select on webhook_events from anon, authenticated;
