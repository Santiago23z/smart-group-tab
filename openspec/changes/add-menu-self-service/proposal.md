# Proposal

## Why

Today a bar's menu is loaded by us from the terminal (`npm run venue:load`). A restaurant cannot
change a price, drop a dish, or say "se acabó el ceviche" without calling someone. The scope was
widened on 2026-09-30 (CLAUDE.md) to a deliberately minimal self-service: upload the spreadsheet,
and mark dishes sold out — no menu-management panel.

## What Changes

- **Subir carta** on the staff screen: the venue picks its CSV (the same template as
  `venue:load`), sees a **preview** — what will be added, updated and hidden, or every error with
  its row — and applies it. Nothing is written until it is applied, and nothing at all if the
  file has errors. It only touches the menu: never tables or QR codes.
- **Agotado / Disponible** per dish on the staff screen. A sold-out dish disappears from the diner
  menu at once and cannot be added; what is already in a cart stays (prices are snapshotted).
- Sold out is **separate from "not on the menu"**: uploading the menu again in the middle of
  service does not bring back a dish marked sold out.
- Both actions are written to the staff action log.
- The staff screen lists the venues its token can act on and asks which one when there is more
  than one; each request names its venue and the server checks every dish belongs to it.

Out of scope: per-dish editing, photos, descriptions, modifiers; per-venue staff accounts (the
token stays per deployment — fine for a one-venue pilot, named as a limitation).

## Capabilities

### New Capabilities
- `menu-self-service`: uploading a venue's menu from the staff screen, and marking dishes sold
  out.

### Modified Capabilities
None.

## Impact

- **DB**: `products.sold_out`; `add_cart_item` refuses a sold-out dish; `staff_set_sold_out`.
- **Code**: `src/admin/venue.mjs` split so the menu part (`loadMenu`) can run alone and as a dry
  run, and errors come back as a list; KDS routes for venues, menu, preview/apply and sold out;
  staff screen "Carta" panel; diner menu hides sold-out dishes.
- **Specs**: 1 new. No new dependencies.
