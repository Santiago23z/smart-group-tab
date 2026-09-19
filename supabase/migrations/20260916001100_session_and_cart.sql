-- Smart Group Tab — the ordering half.
--
-- These produce the rounds the ledger consumes. Two decided rules are enforced
-- here and nowhere else:
--
--   D11 — a cart in collection is frozen. Items ordered while an earlier round is
--         being paid overflow into the next draft round rather than moving a
--         total that live reservations are already pointing at.
--   D18 — voiding is allowed in draft and nowhere else.
--
-- Lock ordering, which matters because two locks are now in play: **session
-- first, then round.** reserve_contribution and confirm_webhook take only the
-- round lock, so there is no cycle. Anything added later that needs both must
-- follow the same order.

-- ---------------------------------------------------------------------------
-- The overflow mechanism (D11).
--
-- Callers must already hold the session lock — this both reads and creates, and
-- two concurrent callers would otherwise open two draft rounds for one table.
-- ---------------------------------------------------------------------------
create or replace function ensure_draft_round(p_session_id uuid)
returns rounds
language plpgsql
as $$
declare
  v_round rounds;
  v_next  integer;
begin
  select * into v_round
    from rounds
   where session_id = p_session_id and status = 'draft';

  if found then
    return v_round;
  end if;

  select coalesce(max(round_number), 0) + 1 into v_next
    from rounds where session_id = p_session_id;

  insert into rounds (session_id, round_number, status, requires_prepayment)
  values (p_session_id, v_next, 'draft', requires_prepayment(p_session_id, v_next))
  returning * into v_round;

  return v_round;
end;
$$;

-- ---------------------------------------------------------------------------
-- Scanning the QR (D9). This is the entire onboarding: no account, no download,
-- no verification email.
-- ---------------------------------------------------------------------------
create or replace function open_or_join_session(p_qr_token text, p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_table       tables;
  v_venue       venues;
  v_session     sessions;
  v_round       rounds;
  v_participant participants;
  v_created     boolean := false;
begin
  if p_nickname is null or length(btrim(p_nickname)) = 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'nickname_required');
  end if;

  -- Serializes the scan. Ten phones hitting one QR at the same instant must open
  -- one tab, not ten.
  select * into v_table
    from tables
   where qr_token = p_qr_token and is_active
     for update;

  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_table');
  end if;

  select * into v_venue from venues where id = v_table.venue_id;

  select * into v_session
    from sessions
   where table_id = v_table.id
     and status in ('open', 'settling', 'needs_staff_attention');

  if not found then
    -- SNAPSHOT 1 (D6): the venue's configuration is copied, not referenced.
    insert into sessions (table_id, venue_id, service_mode, tip_mode, reservation_ttl)
    values (v_table.id, v_table.venue_id,
            v_venue.default_service_mode, v_venue.default_tip_mode, v_venue.reservation_ttl)
    returning * into v_session;
    v_created := true;
  end if;

  v_round := ensure_draft_round(v_session.id);

  begin
    insert into participants (session_id, nickname, kind)
    values (v_session.id, btrim(p_nickname), 'guest')
    returning * into v_participant;
  exception when unique_violation then
    -- Two Santis at one table would make "pay for my items" ambiguous, so the UI
    -- has to ask again rather than us silently renaming anyone.
    return jsonb_build_object(
      'status', 'rejected', 'reason', 'nickname_taken', 'session_id', v_session.id);
  end;

  return jsonb_build_object(
    'status',          'joined',
    'created_session', v_created,
    'session_id',      v_session.id,
    'participant_id',  v_participant.id,
    'round_id',        v_round.id,
    'round_number',    v_round.round_number,
    'service_mode',    v_session.service_mode,
    'venue_id',        v_table.venue_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Ordering.
-- ---------------------------------------------------------------------------
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

  if v_session.status in ('closed', 'settling') then
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

  if not v_product.is_available then
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

-- ---------------------------------------------------------------------------
-- D18 — voiding, draft only.
-- ---------------------------------------------------------------------------
create or replace function void_cart_item(p_cart_item_id uuid, p_participant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item   cart_items;
  v_round  rounds;
  v_caller uuid;
begin
  v_caller := current_participant_id();
  if v_caller is not null and v_caller <> p_participant_id then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'cannot void on behalf of another participant';
  end if;

  select * into v_item from cart_items where id = p_cart_item_id;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_item');
  end if;

  v_round := lock_round(v_item.round_id);

  -- The whole of D18. Once the cart is frozen its total is what live reservations
  -- were computed against, and removing an item would strand them.
  if v_round.status <> 'draft' then
    return jsonb_build_object('status', 'rejected', 'reason', 'round_not_editable');
  end if;

  if v_item.status = 'voided' then
    return jsonb_build_object('status', 'voided', 'cart_item_id', v_item.id);
  end if;

  -- I1a requires a voided item to own nothing.
  delete from cart_item_shares where cart_item_id = v_item.id;

  update cart_items
     set status = 'voided', voided_at = now()
   where id = v_item.id;

  return jsonb_build_object(
    'status',      'voided',
    'cart_item_id', v_item.id,
    'round_id',     v_round.id,
    'round_total',  round_total(v_round.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Re-sharing an item that is already on the table.
--
-- This is the manoeuvre the product is sold on: someone arrives late, joins the
-- picada, and the table's arithmetic rearranges itself without anyone doing
-- mental division.
-- ---------------------------------------------------------------------------
create or replace function set_item_sharing(p_cart_item_id uuid, p_participant_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item    cart_items;
  v_round   rounds;
  v_amounts bigint[];
  i         integer;
begin
  if p_participant_ids is null or cardinality(p_participant_ids) = 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'no_participants');
  end if;

  select * into v_item from cart_items where id = p_cart_item_id;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_item');
  end if;

  v_round := lock_round(v_item.round_id);

  if v_round.status <> 'draft' or v_item.status <> 'active' then
    return jsonb_build_object('status', 'rejected', 'reason', 'round_not_editable');
  end if;

  if exists (
    select 1 from unnest(p_participant_ids) as o
     where not exists (
       select 1 from participants
        where id = o and session_id = v_round.session_id)
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_sharer');
  end if;

  delete from cart_item_shares where cart_item_id = v_item.id;

  v_amounts := allocate_evenly(v_item.line_total, cardinality(p_participant_ids));
  for i in 1 .. cardinality(p_participant_ids) loop
    insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
    values (v_item.id, v_round.id, p_participant_ids[i], v_amounts[i]);
  end loop;

  return jsonb_build_object(
    'status',       'reshared',
    'cart_item_id', v_item.id,
    'shares',       (select jsonb_agg(jsonb_build_object(
                              'share_id',       s.id,
                              'participant_id', s.participant_id,
                              'owed_amount',    s.owed_amount)
                            order by s.id)
                       from cart_item_shares s where s.cart_item_id = v_item.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Closing the round: draft -> collection, or straight to the kitchen.
--
-- This is where the modality snapshot finally does its job (D6, D14).
-- ---------------------------------------------------------------------------
create or replace function close_round(p_session_id uuid, p_split_mode text default 'as_ordered')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session      sessions;
  v_round        rounds;
  v_total        bigint;
  v_participants uuid[];
  v_targets      bigint[];
  v_item         record;
  v_left_item    bigint;
  v_left_target  bigint;
  v_p            integer;
  v_take         bigint;
  v_outcome      text;
begin
  if p_split_mode not in ('as_ordered', 'equal') then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_split_mode');
  end if;

  -- Session before round: see the lock-ordering note at the top of this file.
  select * into v_session from sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_session');
  end if;

  select * into v_round
    from rounds
   where session_id = p_session_id and status = 'draft'
     for update;

  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'no_open_round');
  end if;

  v_total := round_total(v_round.id);
  if v_total = 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'empty_round');
  end if;

  -- -------------------------------------------------------------------------
  -- An equal split re-shards the round rather than claiming against it, which
  -- is why it lives here and not in reserve_contribution. Afterwards everyone
  -- simply pays 'my_items'.
  --
  -- Dividing each item N ways independently would not do: the largest-remainder
  -- extra unit would land on the same person for every single item. Instead each
  -- diner gets an exact target first, and items are then carved to hit those
  -- targets. Both sums come out exact — per item (I1a) and per person.
  -- -------------------------------------------------------------------------
  if p_split_mode = 'equal' then
    select coalesce(array_agg(id order by joined_at, id), '{}') into v_participants
      from participants
     where session_id = p_session_id and kind = 'guest';

    if cardinality(v_participants) = 0 then
      return jsonb_build_object('status', 'rejected', 'reason', 'no_participants');
    end if;

    delete from cart_item_shares where round_id = v_round.id;

    v_targets := allocate_evenly(v_total, cardinality(v_participants));
    v_p := 1;
    v_left_target := v_targets[1];

    for v_item in
      select id, line_total from cart_items
       where round_id = v_round.id and status = 'active'
       order by created_at, id
    loop
      v_left_item := v_item.line_total;

      while v_left_item > 0 loop
        -- Skip anyone whose target is already met, and anyone whose target was
        -- zero to begin with (a bill smaller than the number of diners).
        while v_left_target = 0 and v_p < cardinality(v_targets) loop
          v_p := v_p + 1;
          v_left_target := v_targets[v_p];
        end loop;
        exit when v_left_target = 0;

        v_take := least(v_left_item, v_left_target);

        insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
        values (v_item.id, v_round.id, v_participants[v_p], v_take);

        v_left_item   := v_left_item - v_take;
        v_left_target := v_left_target - v_take;
      end loop;
    end loop;
  end if;

  -- -------------------------------------------------------------------------
  -- The modality decides whether money gates the kitchen.
  -- -------------------------------------------------------------------------
  if v_round.requires_prepayment then
    update rounds set status = 'pending_payment', closed_at = now() where id = v_round.id;
    v_outcome := 'collecting';

  elsif v_session.service_mode = 'hybrid' then
    -- D14: rounds 2+ draw on what the table already paid in. If the credit does
    -- not cover this round, they top up before the kitchen sees it.
    if v_session.prepaid_balance >= v_total then
      update sessions
         set prepaid_balance = prepaid_balance - v_total
       where id = p_session_id;
      v_outcome := 'dispatched';
    else
      update rounds set status = 'pending_payment', closed_at = now() where id = v_round.id;
      v_outcome := 'collecting';
    end if;

  else
    -- open_tab: the kitchen fires now and the bill is settled at close.
    v_outcome := 'dispatched';
  end if;

  if v_outcome = 'dispatched' then
    update rounds
       set status = 'paid_and_dispatched', closed_at = now(), dispatched_at = now()
     where id = v_round.id;

    insert into dispatches (round_id, channel)
    values (v_round.id, 'kds'), (v_round.id, 'print')
        on conflict (round_id, channel) do nothing;
  end if;

  return jsonb_build_object(
    'status',       v_outcome,
    'round_id',     v_round.id,
    'round_number', v_round.round_number,
    'round_total',  v_total,
    'split_mode',   p_split_mode,
    'service_mode', v_session.service_mode);
end;
$$;

grant execute on function
  open_or_join_session(text, text),
  add_cart_item(uuid, uuid, uuid, integer, uuid[]),
  void_cart_item(uuid, uuid),
  set_item_sharing(uuid, uuid[]),
  close_round(uuid, text)
to anon, authenticated;
