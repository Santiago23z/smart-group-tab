# Design

## Context

- `src/admin/venue.mjs` has `parseCsv`, `parseMenu` (throws one message joining every error) and
  `loadVenue` (venue + tables + menu in one transaction). The menu part upserts by name, sets
  `is_available = true` for listed dishes and `false` for the rest.
- `products.is_available` already hides a dish from the diner menu (`/api/state`) and makes
  `add_cart_item` refuse it (`product_unavailable`). Because reloading sets it back to `true`, it
  cannot also mean "sold out".
- The KDS has one staff token per deployment and already acts across venues (it lists every open
  table and collection).

## Goals / Non-Goals

**Goals:** one code path for menus from the terminal and from the screen; nothing written without
an explicit apply; sold out survives a reload.

**Non-Goals:** per-dish editor, photos, modifiers; per-venue accounts.

## Decisions

**D1 — `products.sold_out boolean`**, separate from `is_available`. Diner menu shows
`is_available and not sold_out`; `add_cart_item` refuses either with the existing
`product_unavailable`. `loadMenu` never touches `sold_out`.

**D2 — Split `loadMenu(db, venueId, menu, { dryRun })` out of `loadVenue`.** `loadVenue` keeps
calling it. It returns the names added, updated and hidden. A dry run does the same writes inside
a transaction and rolls back, so preview and apply can never disagree about what would happen.

**D3 — Errors as a list.** `parseMenu` throws an error carrying `errors: string[]` (the message
stays the joined text the CLI prints). The KDS returns them as `422 { errors }`.

**D4 — Routes.** `GET /kds/api/venues` (id, name); `GET /kds/api/venues/:id/menu` (dishes with
category, price, tax, available, sold_out); `POST /kds/api/venues/:id/menu` with
`{ csv, apply: false|true }` (body up to 1 MB); `POST /kds/api/venues/:id/products/:pid/sold-out`
with `{ sold_out }`. The upload runs in Node (the parser is JavaScript) but writes through the
same SQL; the sold-out change is a `SECURITY DEFINER` function `staff_set_sold_out(venue,
product, flag)` that checks the dish belongs to the venue and logs.

**D5 — Venue choice.** The screen loads the venue list; with one venue it is implicit, with
several it shows a selector and remembers the choice on the tablet. Every request carries the
venue id; the server refuses a dish from another venue.

**D6 — Screen.** A "Carta" button in the kitchen screen's header opens a panel: dishes grouped by
category with an "Agotado" switch each, and "Subir carta" (file picker → preview dialog listing
added / updated / hidden, or the errors → "Aplicar").

## Risks / Trade-offs

- [Wrong file uploaded hides the whole menu] → the preview shows how many dishes would be hidden
  before anything is written.
- [Shared token can edit any venue's menu] → same trust boundary as the rest of the staff screen;
  fine for a one-venue pilot; per-venue accounts are the fix, out of scope.
- [A sold-out dish in a diner's open cart] → stays: its price was snapshotted, and removing ordered
  food is a round-lifecycle decision, not a menu one.

## Migration Plan

One additive migration (`sold_out`, `add_cart_item` replaced with one extra check,
`staff_set_sold_out`). Rollback: the column defaults to `false`.
