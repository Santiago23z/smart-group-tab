# Tasks

## 1. Data and rules

- [ ] 1.1 Migration `supabase/migrations/20261001000100_menu_self_service.sql`: `products.sold_out`, `add_cart_item` refuses sold-out dishes, `staff_set_sold_out(venue, product, flag)` with venue check and log; verify schema and the existing suite.
- [ ] 1.2 `src/admin/venue.mjs`: `loadMenu` split out with dry run and name lists; `parseMenu` errors as a list; `loadVenue` unchanged in behaviour; verify `tests/venue-setup.test.mjs` plus: dry run writes nothing, reload keeps `sold_out`, hidden dish stays hidden.
- [ ] 1.3 Diner menu hides sold-out dishes; verify in `tests/session-and-cart.test.mjs` or a new test that adding a sold-out dish is refused with `product_unavailable` and a cart item added before stays.

## 2. Staff screen

- [ ] 2.1 KDS routes (D4) with tests in `tests/kds.test.mjs`: venues list, menu, preview (no write), apply, 422 with errors, sold out on/off, dish of another venue refused, staff token only.
- [ ] 2.2 "Carta" panel (D6) with Playwright: mark a dish sold out and see it vanish from a diner's menu; upload a file with an error and see the row; upload a valid file, see the preview, apply it.

## 3. Docs and verification

- [ ] 3.1 README and `docs/estado-actual.md`.
- [ ] 3.2 `npm run test:all` green; migrate the demo database and audit.
