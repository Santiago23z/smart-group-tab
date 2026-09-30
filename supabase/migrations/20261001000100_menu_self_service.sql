-- Smart Group Tab — minimal menu self-service (CLAUDE.md, 2026-09-30).
--
-- "Sold out" is its own flag, not is_available: is_available means "on the
-- menu", and uploading the menu sets it for every listed dish. Sharing the flag
-- would mean an upload in the middle of service un-sells the ceviche that ran
-- out. The upload itself runs in Node (src/admin/venue.mjs); this is the part
-- that has to be SQL: the flag, the refusal, and the staff action.

alter table products add column sold_out boolean not null default false;

create or replace function add_cart_item(
  p_session_id     uuid,
  p_participant_id uuid,
  p_product_id     uuid,
  p_quantity       integer default 1,
  p_shared_with    uuid[]  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session sessions;
  v_round   rounds;
  v_product products;
  v_item    cart_items;
  v_caller  uuid;
  v_owners  uuid[];
  v_amounts bigint[];
  i         integer;
begin
  v_caller := current_participant_id();
  if v_caller is not null and v_caller <> p_participant_id then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'cannot order on behalf of another participant';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_quantity');
  end if;

  select * into v_session from sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_session');
  end if;

  -- The bill was asked for: nothing new, whatever the status says (a late
  -- payment can flag a settling table without reopening it).
  if v_session.status in ('closed', 'settling') or v_session.bill_requested_at is not null then
    return jsonb_build_object('status', 'rejected', 'reason', 'session_closed');
  end if;

  if not exists (
    select 1 from participants where id = p_participant_id and session_id = p_session_id
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'participant_not_in_session');
  end if;

  select * into v_product
    from products
   where id = p_product_id and venue_id = v_session.venue_id;

  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_product');
  end if;

  -- Off the menu, or sold out for tonight: the same refusal either way.
  if not v_product.is_available or v_product.sold_out then
    return jsonb_build_object('status', 'rejected', 'reason', 'product_unavailable');
  end if;

  -- Validated before anything is written, so a bad owner list never leaves a
  -- half-built item behind.
  v_owners := coalesce(nullif(p_shared_with, '{}'), array[p_participant_id]);
  if exists (
    select 1 from unnest(v_owners) as o
     where not exists (select 1 from participants where id = o and session_id = p_session_id)
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_sharer');
  end if;

  -- D11. Resolves to the round in draft, or opens the overflow round when the
  -- previous one has already gone to collection.
  v_round := ensure_draft_round(p_session_id);

  -- SNAPSHOT 2: price and tax are copied off the menu here and never read again.
  insert into cart_items
    (round_id, product_id, quantity, unit_price, tax_rate, added_by_participant_id)
  values (v_round.id, v_product.id, p_quantity,
          v_product.unit_price, v_product.tax_rate, p_participant_id)
  returning * into v_item;

  -- I1a: largest-remainder, so the shares sum to line_total exactly however
  -- awkward the division.
  v_amounts := allocate_evenly(v_item.line_total, cardinality(v_owners));

  for i in 1 .. cardinality(v_owners) loop
    insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
    values (v_item.id, v_round.id, v_owners[i], v_amounts[i]);
  end loop;

  return jsonb_build_object(
    'status',       'added',
    'cart_item_id', v_item.id,
    'round_id',     v_round.id,
    'round_number', v_round.round_number,
    'line_total',   v_item.line_total,
    'shares',       (select jsonb_agg(jsonb_build_object(
                              'share_id',       s.id,
                              'participant_id', s.participant_id,
                              'owed_amount',    s.owed_amount)
                            order by s.id)
                       from cart_item_shares s where s.cart_item_id = v_item.id));
end;
$$;

/** Mark a dish sold out, or back. The dish must belong to the venue named. */
create or replace function staff_set_sold_out(p_venue_id uuid, p_product_id uuid, p_sold_out boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product products;
begin
  select * into v_product from products where id = p_product_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_product');
  end if;
  if v_product.venue_id is distinct from p_venue_id then
    return jsonb_build_object('status', 'rejected', 'reason', 'product_of_another_venue');
  end if;
  if p_sold_out is null then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_flag');
  end if;

  if v_product.sold_out is distinct from p_sold_out then
    update products set sold_out = p_sold_out where id = p_product_id;
    -- Not a session action: the log's session column stays empty.
    perform staff_log(case when p_sold_out then 'sold_out' else 'back_in_stock' end,
                      p_product_id, null, jsonb_build_object('venue_id', p_venue_id, 'name', v_product.name));
  end if;

  return jsonb_build_object('status', 'updated', 'product_id', p_product_id, 'sold_out', p_sold_out);
end;
$$;

revoke all on function staff_set_sold_out(uuid, uuid, boolean) from public, anon, authenticated;
