-- Smart Group Tab — remembering which reservations reached Wompi.
--
-- I3 held only if the webhook was delivered at least once. When it is not, the
-- money has still moved, and the only way to find out is to ask Wompi. Asking
-- about every reservation would be mostly wasted calls — most never reach the
-- checkout — so a row lands here the moment a checkout is issued, and only those
-- rows are ever checked.

create table reservation_checkouts (
  reservation_id  uuid primary key references contribution_reservations (id) on delete cascade,
  first_issued_at timestamptz not null default now(),
  last_issued_at  timestamptz not null default now(),
  -- Doubles as a lease, as in the dispatch outbox: claiming a row pushes it
  -- forward, so a crashed or slow checker just means the row comes due again.
  next_check_at   timestamptz not null default now(),
  check_count     integer not null default 0 check (check_count >= 0),
  last_checked_at timestamptz,
  -- What Wompi said last time, for whoever is looking at this by hand.
  last_outcome    text
);

create index reservation_checkouts_due_idx on reservation_checkouts (next_check_at);

/** A checkout was handed to a diner. Re-issuing never resets the 24-hour window. */
create or replace function record_checkout_issued(p_reservation_id uuid)
returns void
language sql
as $$
  insert into reservation_checkouts (reservation_id)
  values (p_reservation_id)
  on conflict (reservation_id) do update
    set last_issued_at = now();
$$;

/**
 * Claims the reservations due for a check: a checkout was issued within the
 * window and Wompi's outcome has not reached us yet. `active` includes lapsed
 * holds on purpose — expiry is lazy, and a late approval for a lapsed hold is
 * exactly the money this exists to find. `expired` is the housekeeping spelling
 * of the same thing.
 */
create or replace function claim_due_checkouts(
  p_interval interval,
  p_window   interval default interval '24 hours',
  p_limit    integer  default 50
)
returns table (reservation_id uuid, psp_reference text)
language sql
as $$
  with due as (
    select rc.reservation_id
      from reservation_checkouts rc
      join contribution_reservations r on r.id = rc.reservation_id
     where rc.next_check_at <= now()
       and rc.first_issued_at > now() - p_window
       and r.status in ('active', 'expired')
     order by rc.next_check_at
     limit p_limit
       for update of rc skip locked
  )
  update reservation_checkouts rc
     set next_check_at = now() + p_interval,
         check_count   = rc.check_count + 1
    from due, contribution_reservations r
   where rc.reservation_id = due.reservation_id
     and r.id = rc.reservation_id
  returning rc.reservation_id, r.psp_reference;
$$;

create or replace function record_checkout_check(p_reservation_id uuid, p_outcome text)
returns void
language sql
as $$
  update reservation_checkouts
     set last_checked_at = now(), last_outcome = p_outcome
   where reservation_id = p_reservation_id;
$$;

alter table reservation_checkouts enable row level security;
revoke all on reservation_checkouts from public, anon, authenticated;
revoke all on function record_checkout_issued(uuid),
                       claim_due_checkouts(interval, interval, integer),
                       record_checkout_check(uuid, text)
  from public, anon, authenticated;
