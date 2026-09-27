# Tasks

## 1. Schema

- [x] 1.1 Migration `supabase/migrations/20260929000100_close_session.sql`, part 1: `session_id` on reservations and contributions (backfilled, `NOT NULL`), `round_id` nullable, `sessions.bill_requested_at`, `rounds.paid_from_balance`, `write_offs`, `write_off_shares` (append-only, RLS on, grants revoked); verify with `npm run verify:schema` and the whole existing suite (`npm test`) still green.

## 2. Settlement rules (SQL)

- [x] 2.1 `close_round` sets `paid_from_balance` on the hybrid balance path (D4); verify in `tests/close-session.test.mjs`: a balance-paid hybrid round adds nothing to the tab.
- [x] 2.2 `session_tab` / `tab_summary` (D3); verify: open tab of three rounds = their sum; pay-before-order = 0; written-off and paid shares excluded.
- [x] 2.3 `request_bill` and the ordering guards (D5); verify: settlement refuses add/close/share/void; refused with a non-empty draft; idempotent; a flagged session stays flagged but still refuses orders; alert cleared during settlement returns to `settling`.
- [x] 2.4 `reserve_tab` (D6); verify: "mine" spans rounds and only the caller's shares; "remaining" takes all; refused before the bill; two concurrent "remaining" → one holds, one `nothing_available` (race test, repeated).
- [x] 2.5 `confirm_webhook` tab branch → `confirm_tab_payment` (D7); verify: approval settles every allocated share; decline releases; duplicate event; late payment after shares retaken → credited + flagged; webhook-after-reconcile duplicate.
- [x] 2.6 `staff_write_off` (D8); verify: whole tab written off with reason; refused with empty reason, outside settlement, or with a live tab hold.
- [x] 2.7 `try_close_session` / `staff_close_session` (D9); verify: closes on last payment and on write-off; refusal lists every blocking reason; a closed table opens a new session on the next join.
- [x] 2.8 Callers (D10): `staff_release_reservation`, `staff_collections`, `staff_resolve_if_clear`, audit invariants (allocation-based per-round money, no share settled and written off, closed session has no tab); verify `npm run audit:test` 10+/10+ after the suite.

## 3. Servers

- [x] 3.1 Diner API: `POST /api/bill`, `POST /api/reserve-tab`, tab in `/api/state`; `createPaymentIntent` reads the session from the reservation; verify in `tests/checkout.test.mjs` (a tab reservation gets a checkout for its total and its table's return URL) and an API test for the routes.
- [x] 3.2 Reconciliation: a tab payment found by the periodic check and by the on-return check settles the tab; verify in `tests/reconcile.test.mjs`.
- [x] 3.3 KDS: `open_tables` in state; `POST /kds/api/sessions/:id/bill`, `/write-off`, `/close`; verify in `tests/kds.test.mjs` (staff token only; refusals 409 with reasons).

## 4. Screens

- [x] 4.1 Diner page: "Pedir la cuenta", tab view with "Pagar lo mío" / "Cubrir el resto"; verify with Playwright: open-tab table of two diners asks for the bill, each pays their part, the table closes.
- [x] 4.2 Kitchen: "Mesas abiertas" with tab, "Pedir la cuenta", "Asumir pérdida" (confirm + reason), "Cerrar mesa" with reasons; verify with Playwright: write-off closes a departed table; close refused while credit remains.

## 5. Docs and verification

- [x] 5.1 README and `docs/estado-actual.md` (option 3 done; limitations: no reopen, no cash).
- [ ] 5.2 `npm run test:all` green; `npm run audit` on the demo database green after migrating.
- [ ] 5.3 Live check with the Wompi sandbox on an `open_tab` table (switch the seed venue's mode for the demo): two phones order two rounds each, ask for the bill, each pays "lo mío" in one checkout, the table closes; then a second table leaves unpaid and staff write it off.
