-- Smart Group Tab — one photo per dish (CLAUDE.md, 2026-10-02).
--
-- The staff browser shrinks the image before sending it (a list thumbnail and
-- a larger version), so nothing here decodes images. They live apart from
-- `products` so that no menu query ever drags image bytes along, and are keyed
-- by product id, which menu uploads never change.

create table product_photos (
  product_id   uuid primary key references products (id) on delete cascade,
  thumb        bytea not null,
  large        bytea not null,
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  -- Part of every photo address: a replaced photo gets a new address, so a
  -- phone's cache can keep each one forever and never show a stale image.
  hash         text not null,
  updated_at   timestamptz not null default now(),

  -- Defence in depth: the staff screen sends ~20 KB and ~150 KB.
  constraint product_photos_sizes check (octet_length(thumb) <= 122880 and octet_length(large) <= 716800)
);

create or replace function staff_set_photo(
  p_venue_id uuid, p_product_id uuid, p_thumb bytea, p_large bytea, p_content_type text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product products;
  v_hash    text;
begin
  select * into v_product from products where id = p_product_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_product');
  end if;
  if v_product.venue_id is distinct from p_venue_id then
    return jsonb_build_object('status', 'rejected', 'reason', 'product_of_another_venue');
  end if;
  if p_content_type is null or p_content_type not in ('image/jpeg', 'image/png', 'image/webp') then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_type');
  end if;
  if p_thumb is null or p_large is null
     or octet_length(p_thumb) > 122880 or octet_length(p_large) > 716800 then
    return jsonb_build_object('status', 'rejected', 'reason', 'too_large');
  end if;

  v_hash := left(encode(sha256(p_thumb || p_large), 'hex'), 16);

  insert into product_photos (product_id, thumb, large, content_type, hash)
  values (p_product_id, p_thumb, p_large, p_content_type, v_hash)
  on conflict (product_id) do update
    set thumb = excluded.thumb, large = excluded.large,
        content_type = excluded.content_type, hash = excluded.hash, updated_at = now();

  perform staff_log('photo_set', p_product_id, null, jsonb_build_object(
    'venue_id', p_venue_id, 'name', v_product.name, 'hash', v_hash,
    'bytes', octet_length(p_thumb) + octet_length(p_large)));

  return jsonb_build_object('status', 'updated', 'product_id', p_product_id, 'hash', v_hash);
end;
$$;

create or replace function staff_remove_photo(p_venue_id uuid, p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product products;
  v_removed integer;
begin
  select * into v_product from products where id = p_product_id;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_product');
  end if;
  if v_product.venue_id is distinct from p_venue_id then
    return jsonb_build_object('status', 'rejected', 'reason', 'product_of_another_venue');
  end if;

  delete from product_photos where product_id = p_product_id;
  get diagnostics v_removed = row_count;
  if v_removed = 1 then
    perform staff_log('photo_removed', p_product_id, null,
                      jsonb_build_object('venue_id', p_venue_id, 'name', v_product.name));
  end if;

  return jsonb_build_object('status', 'removed', 'product_id', p_product_id);
end;
$$;

alter table product_photos enable row level security;
revoke all on product_photos from public, anon, authenticated;
revoke all on function staff_set_photo(uuid, uuid, bytea, bytea, text),
                       staff_remove_photo(uuid, uuid)
  from public, anon, authenticated;
