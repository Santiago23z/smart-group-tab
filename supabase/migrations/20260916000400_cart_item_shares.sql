-- Smart Group Tab — cart item shares (D16).
--
-- The atomic unit of debt is not the peso, it is the *share*: a fraction of a
-- cart item carrying an absolute amount in minor units. An item split three ways
-- is three shares of the same cart_item.
--
-- Shares are divisible. When a free-amount contribution lands mid-share, the
-- reservation RPC splits that share into a covered portion and a remainder,
-- inside the serialized section. Only unclaimed shares are ever split; a claimed
-- share is never touched. That is what lets all six split modes from the strategy
-- doc reduce to one mechanism: a set of claims over shares.
--
-- Amounts are absolute, never fractions. Storing fractions produces rounding
-- drift; the allocation helper distributes remainders by largest-remainder so the
-- sum is exact.

create table cart_item_shares (
  id             uuid primary key default gen_random_uuid(),
  cart_item_id   uuid not null references cart_items (id) on delete cascade,
  -- Denormalised from cart_items. Every money RPC locks the round first, and
  -- every share lookup filters by round; carrying it here avoids a join on the
  -- hottest path in the system.
  round_id       uuid not null references rounds (id) on delete cascade,
  -- Null means the share has no assigned owner yet: it belongs to the table at
  -- large and anyone may claim it. Assigned shares are what "pay for my items"
  -- resolves against.
  participant_id uuid references participants (id) on delete restrict,
  owed_amount    money_amount not null check (owed_amount > 0),
  created_at     timestamptz not null default now()
);

create index cart_item_shares_round_idx on cart_item_shares (round_id);
create index cart_item_shares_item_idx on cart_item_shares (cart_item_id);
create index cart_item_shares_participant_idx on cart_item_shares (participant_id)
  where participant_id is not null;

-- ---------------------------------------------------------------------------
-- I1a — Conservation.
--
-- The shares of an active cart item sum to exactly its line_total; a voided item
-- owns no shares. Splitting preserves the sum, so this holds through every
-- reservation. Enforced as a deferred constraint trigger rather than by
-- convention: a split is two statements, and the invariant is only true again
-- once both have run.
-- ---------------------------------------------------------------------------

create or replace function assert_item_share_conservation(p_cart_item_id uuid)
returns void
language plpgsql
as $$
declare
  v_status     cart_item_status;
  v_line_total bigint;
  v_shares     bigint;
begin
  select status, line_total
    into v_status, v_line_total
    from cart_items
   where id = p_cart_item_id;

  if not found then
    -- The item was deleted in this transaction; its shares cascaded with it.
    return;
  end if;

  select coalesce(sum(owed_amount), 0)
    into v_shares
    from cart_item_shares
   where cart_item_id = p_cart_item_id;

  if v_status = 'active' and v_shares <> v_line_total then
    raise exception using
      errcode = 'integrity_constraint_violation',
      message = format(
        'I1a violated: cart_item %s has shares summing %s but line_total is %s',
        p_cart_item_id, v_shares, v_line_total);
  end if;

  if v_status = 'voided' and v_shares <> 0 then
    raise exception using
      errcode = 'integrity_constraint_violation',
      message = format(
        'I1a violated: voided cart_item %s still owns %s in shares',
        p_cart_item_id, v_shares);
  end if;
end;
$$;

create or replace function tg_assert_shares_conservation()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform assert_item_share_conservation(new.cart_item_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    perform assert_item_share_conservation(old.cart_item_id);
  end if;
  return null;
end;
$$;

create constraint trigger cart_item_shares_conservation
  after insert or update or delete on cart_item_shares
  deferrable initially deferred
  for each row execute function tg_assert_shares_conservation();

create or replace function tg_assert_item_conservation()
returns trigger
language plpgsql
as $$
begin
  perform assert_item_share_conservation(new.id);
  return null;
end;
$$;

-- Catches the other direction: an item inserted with no shares at all, or a
-- quantity change that moves line_total away from its shares.
create constraint trigger cart_items_conservation
  after insert or update on cart_items
  deferrable initially deferred
  for each row execute function tg_assert_item_conservation();
