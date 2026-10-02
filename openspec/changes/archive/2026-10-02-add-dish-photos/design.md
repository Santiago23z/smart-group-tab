# Design

## Context

- Dishes are `products` (`is_available`, `sold_out`); the diner menu comes from `/api/state`,
  polled every 2 s, and `renderMenu()` replaces `#menu-list`'s HTML on every poll.
- The diner server (`src/api/server.mjs`) serves static files from `public/`; the staff screen
  talks to `src/kds/app.mjs`, whose "Carta" panel lists dishes per venue.
- `loadMenu` matches dishes by name and updates rows in place, so a product id is stable across
  uploads.

## Goals / Non-Goals

**Goals:** photos fast on bad wifi; no new service or dependency; never stale; nothing changes for
menus without photos.

**Non-Goals:** server-side resizing, photos from the spreadsheet, galleries, descriptions.

## Decisions

**D1 — Resize in the staff browser.** `createImageBitmap` + canvas → JPEG (quality ~0.8): thumb
240 px and large 800 px on the long side. JPEG because every browser in play encodes it (WebP
encoding is not reliable in Safari). The server never decodes images, so no image library. A
format the browser cannot decode (e.g. HEIC on a desktop) fails on the tablet with a clear
message; iPhones and iPads hand the page a JPEG anyway.

**D2 — `product_photos`, apart from `products`.** `(product_id pk → products, thumb bytea,
large bytea, content_type, hash text, updated_at)`. Kept out of `products` so menu queries never
drag image bytes. `hash` = sha256 of both images, short form, computed by the server.

**D3 — Upload contract.** `PUT /kds/api/venues/:v/products/:p/photo` with JSON
`{ thumb, large }` as base64 (one request, ~150 KB typical). Server checks magic bytes
(JPEG/PNG/WebP), `thumb ≤ 120 KB`, `large ≤ 700 KB`, then calls `staff_set_photo(venue, product,
thumb, large, type)` (venue check + log). `DELETE` → `staff_remove_photo`. Body limit 1.2 MB.

**D4 — Serving.** Diner server: `GET /photos/<product>/<hash>/<thumb|large>.jpg` → bytes with
`Cache-Control: public, max-age=31536000, immutable`; 404 if the hash is not the current one
(an old address never serves a new image). `/api/state` menu rows carry `photo` (the hash or
null); the page builds the URLs.

**D5 — Render the menu only when it changes.** `renderMenu()` keeps a key of the menu's ids,
names, prices and photo hashes and returns early when unchanged. Thumbnails use
`loading="lazy"`, fixed size (no layout jump), `decoding="async"`; tapping opens a full-screen
sheet with the large photo.

**D6 — Upload never touches photos.** `loadMenu` writes only `products`; photos are keyed by
product id, which uploads keep.

## Risks / Trade-offs

- [Postgres grows with images] → ~150 KB per dish; a 60-dish menu ≈ 9 MB. Fine for one venue;
  object storage is the move if this ever hurts.
- [A huge source image on an old tablet] → resizing a 12 MP photo takes a second or two; the
  panel shows "Procesando…".
- [Base64 inflates the request by a third] → still ~200 KB per save; simpler than multipart with
  no dependency.

## Migration Plan

One additive migration. Rollback: drop the table; menus render as text.
