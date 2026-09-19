-- Smart Group Tab — policy functions, identity helpers, and share availability.
--
-- Nothing here writes. These are the shared reads that the money RPCs in phase 2
-- build on, plus the exact-sum allocator every split depends on.

-- ---------------------------------------------------------------------------
-- Identity (D9).
--
-- A guest has no account. The API layer proves who they are by putting their
-- participant id in the request context. Under Supabase that arrives as a
-- verified JWT claim; under plain Postgres (tests, psql) it arrives as a session
-- GUC. Supporting both means the same RLS policies run in both environments.
-- ---------------------------------------------------------------------------
create or replace function current_participant_id()
returns uuid
language plpgsql
stable
as $$
declare
  v_raw text;
begin
  begin
    v_raw := nullif(current_setting('request.jwt.claims', true), '')::jsonb
               ->> 'participant_id';
  exception when others then
    v_raw := null;
  end;

  if v_raw is null then
    v_raw := nullif(current_setting('app.participant_id', true), '');
  end if;

  return v_raw::uuid;
exception when others then
  return null;
end;
$$;

-- SECURITY DEFINER is load-bearing here, not a convenience.
--
-- This reads `participants`, and the RLS policy on `participants` calls this
-- function to decide what you may see. Without DEFINER that is unbounded
-- recursion — Postgres unwinds it as ERRORDATA_STACK_SIZE exceeded, and every
-- policy that transitively depends on it dies with it. DEFINER makes this one
-- read bypass RLS, which breaks the cycle at its root.
--
-- It is safe to bypass precisely because the function leaks nothing: it maps the
-- caller's own already-proven identity to its session id and returns nothing else.
create or replace function current_session_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select session_id from participants where id = current_participant_id();
$$;

-- ---------------------------------------------------------------------------
-- The exact-sum allocator.
--
-- Used wherever a total is divided: an item shared N ways, an equal split of a
-- round. Largest-remainder, so the first (total mod parts) slices absorb one
-- extra minor unit each and the array sums to exactly the total. This is why
-- shares store absolute amounts and never fractions — fractions drift, this does
-- not.
-- ---------------------------------------------------------------------------
create or replace function allocate_evenly(p_total bigint, p_parts integer)
returns bigint[]
language plpgsql
immutable
as $$
declare
  v_base bigint;
  v_rem  bigint;
  v_out  bigint[] := '{}';
  i      integer;
begin
  if p_parts is null or p_parts <= 0 then
    raise exception 'allocate_evenly: parts must be positive, got %', p_parts;
  end if;
  if p_total is null or p_total < 0 then
    raise exception 'allocate_evenly: total must be non-negative, got %', p_total;
  end if;

  v_base := p_total / p_parts;
  v_rem  := p_total % p_parts;

  for i in 1 .. p_parts loop
    v_out := v_out || (v_base + case when i <= v_rem then 1 else 0 end)::bigint;
  end loop;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- The serialization point.
--
-- Every RPC that touches money calls this FIRST. It is the only mutual-exclusion
-- mechanism in the system: with ~10 people per table, contention is low enough
-- that a row lock is the simple and obviously correct answer, and unlike a
-- partial unique index it can coexist with lazy expiry.
-- ---------------------------------------------------------------------------
create or replace function lock_round(p_round_id uuid)
returns rounds
language plpgsql
as $$
declare
  v_round rounds;
begin
  select * into v_round
    from rounds
   where id = p_round_id
     for update;

  if not found then
    raise exception using
      errcode = 'no_data_found',
      message = format('unknown round %s', p_round_id);
  end if;

  return v_round;
end;
$$;

-- ---------------------------------------------------------------------------
-- Modality policy (D6, D14).
-- ---------------------------------------------------------------------------
create or replace function requires_prepayment(p_session_id uuid, p_round_number integer)
returns boolean
language plpgsql
stable
as $$
declare
  v_mode service_mode;
begin
  -- Reads the session's SNAPSHOT, never the venue's current configuration.
  select service_mode into v_mode
    from sessions
   where id = p_session_id;

  if not found then
    raise exception using
      errcode = 'no_data_found',
      message = format('unknown session %s', p_session_id);
  end if;

  return case v_mode
    when 'pay_before_order' then true
    when 'open_tab'         then false
    -- D14: round 1 must be fully collected; rounds 2+ draw on prepaid_balance.
    when 'hybrid'           then p_round_number = 1
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Round arithmetic and share availability.
-- ---------------------------------------------------------------------------
create or replace function round_total(p_round_id uuid)
returns bigint
language sql
stable
as $$
  select coalesce(sum(line_total), 0)::bigint
    from cart_items
   where round_id = p_round_id
     and status = 'active';
$$;

-- Shares belonging to items that are still active. Voided items keep no shares
-- (I1a), but filtering by item status keeps every caller honest.
create or replace function active_shares(p_round_id uuid)
returns setof cart_item_shares
language sql
stable
as $$
  select s.*
    from cart_item_shares s
    join cart_items ci on ci.id = s.cart_item_id
   where s.round_id = p_round_id
     and ci.status = 'active';
$$;

-- I1b — a share is held if some reservation owns it and that reservation is
-- either settled, or still inside its TTL. The `expires_at > now()` half is the
-- lazy expiry (D8): nothing has to run on time for this to be correct.
create or replace function is_share_held(p_share_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
      from reservation_allocations ra
      join contribution_reservations r on r.id = ra.reservation_id
     where ra.cart_item_share_id = p_share_id
       and (r.status = 'confirmed'
            or (r.status = 'active' and r.expires_at > now()))
  );
$$;

-- Settled is stricter than held: only a confirmed payment counts. This is what
-- gates dispatch.
create or replace function is_share_settled(p_share_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
      from reservation_allocations ra
      join contribution_reservations r on r.id = ra.reservation_id
     where ra.cart_item_share_id = p_share_id
       and r.status = 'confirmed'
  );
$$;

create or replace function free_shares(p_round_id uuid)
returns setof cart_item_shares
language sql
stable
as $$
  select s.*
    from active_shares(p_round_id) s
   where not is_share_held(s.id)
   -- Deterministic order so a free-amount claim is reproducible: cheapest first,
   -- then by age. Splitting the last one is then the only rounding decision.
   order by s.owed_amount, s.created_at, s.id;
$$;

create or replace function round_outstanding(p_round_id uuid)
returns bigint
language sql
stable
as $$
  select coalesce(sum(owed_amount), 0)::bigint from free_shares(p_round_id);
$$;

-- D16: completion is "every active share is settled", not "the sum reached the
-- total". They coincide by I1a, but the share version is what fires the kitchen
-- and it is the stricter of the two.
create or replace function round_is_fully_settled(p_round_id uuid)
returns boolean
language sql
stable
as $$
  select exists (select 1 from active_shares(p_round_id))
     and not exists (
       select 1 from active_shares(p_round_id) s
        where not is_share_settled(s.id)
     );
$$;
