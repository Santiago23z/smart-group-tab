-- Smart Group Tab — the kitchen ticket.
--
-- What the outbox worker delivers. Built here rather than assembled in Node for
-- the same reason nothing else computes money in Node: one place decides what a
-- round contains, and the worker stays a shell around decisions made elsewhere.
--
-- MONEY IS EXCLUDED STRUCTURALLY, NOT BY CONVENTION. Every field is named
-- explicitly. There is no to_jsonb() of a whole row and no spread that could
-- quietly start carrying owed_amount the next time something upstream changes
-- shape. The kitchen needs to know what to cook and for which table; it has no
-- business with the bill, and a ticket that leaks a balance onto a pass-through
-- screen is a privacy problem, not a formatting one.
--
-- Only `active` items appear: D18 voids are removals, and cooking something a
-- diner cancelled is exactly the failure the void exists to prevent.

create or replace function dispatch_ticket(p_round_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'round_id',     r.id,
    'round_number', r.round_number,
    'dispatched_at', r.dispatched_at,
    'venue',        jsonb_build_object('name', v.name),
    'table',        jsonb_build_object('label', t.label),
    'items', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'name',        pr.name,
            'category',    pr.category,
            'quantity',    ci.quantity,
            'ordered_by',  p.nickname)
          order by ci.created_at, ci.id),
        '[]'::jsonb)
        from cart_items ci
        join products pr on pr.id = ci.product_id
        join participants p on p.id = ci.added_by_participant_id
       where ci.round_id = r.id
         and ci.status = 'active')
  )
    from rounds r
    join sessions s on s.id = r.session_id
    join tables t on t.id = s.table_id
    join venues v on v.id = s.venue_id
   where r.id = p_round_id;
$$;

-- The worker connects as the owner, not as a client. Clients have no reason to
-- read this at all: a diner already has the cart, and the KDS receives the
-- ticket pushed to it rather than pulling one.
revoke all on function dispatch_ticket(uuid) from public, anon, authenticated;
