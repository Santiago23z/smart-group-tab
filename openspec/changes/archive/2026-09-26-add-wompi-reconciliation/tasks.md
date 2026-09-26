# Tasks

## 1. Verify the Wompi API (decision gate)

- [x] 1.1 With `WOMPI_PRIVATE_KEY` in `.env`, run `curl -s "https://sandbox.wompi.co/v1/transactions?reference=<a paid reference>" -H "Authorization: Bearer $WOMPI_PRIVATE_KEY"` and `curl -s "https://sandbox.wompi.co/v1/transactions/<id>" -H "Authorization: Bearer $WOMPI_PRIVATE_KEY"`; record status codes and response shapes (array vs object) in design.md. If the reference lookup fails, stop and re-plan tasks 4–5 with the user.

## 2. Wompi API client

- [x] 2.1 Add `src/wompi/api.mjs` (`getTransaction`, `findByReference`, bearer private key, 10 s timeout, injectable `fetchImpl`); verify with `tests/wompi-api.test.mjs` against a fake HTTP server: auth header sent, 404 → `not_found`, timeout and 5xx → error, key never appears in thrown messages.

## 3. Reconcile one transaction

- [x] 3.1 Add `reconcileTransaction(pool, tx)` in `src/wompi/reconcile.mjs`: wrap as `{ data: { transaction } }`, reuse `parseTransactionEvent`, skip `PENDING`, call `confirm_webhook` with payload `{ source: 'wompi_api', ... }` trimmed per D10 (no personal data); verify in `tests/reconcile.test.mjs`: approved settles and dispatches, declined releases, pending changes nothing, unknown reference settles nothing.
- [x] 3.2 Verify idempotency in `tests/reconcile.test.mjs`: lookup then webhook → webhook gets `duplicate_event`; webhook then lookup → `duplicate_event`; one contribution in both cases.
- [x] 3.3 Verify late money in `tests/reconcile.test.mjs`: approved lookup for a lapsed hold whose shares were retaken → credited to prepaid balance, session `requires_staff_attention`.

## 4. Record issued checkouts

- [x] 4.1 Add migration `supabase/migrations/20260927000100_reservation_checkouts.sql` (table, RLS on, grants revoked) and run `npm run db:migrate` and `npm run verify:schema`.
- [x] 4.2 Make `createPaymentIntent` upsert `reservation_checkouts` on `created` and build `redirect-url = <origin>/t/<qr_token>` (D7); verify in `tests/checkout.test.mjs`: row created once, re-issue updates `last_issued_at`, refused intent writes nothing, redirect URL uses the table's QR token.

## 5. Periodic check

- [x] 5.1 Add `reconcileDue(pool, { api, intervalSeconds })`: claim due rows with `for update skip locked`, look up by reference (D4), set `next_check_at`, `check_count`, `last_outcome`; verify in `tests/reconcile.test.mjs`: settled/released/older-than-24h/never-issued rows are not checked, Wompi error leaves the ledger unchanged and the row due next interval, decline+approval on one reference settles.
- [x] 5.2 Run the loop in `src/wompi/server.mjs` every `WOMPI_RECONCILE_SECONDS` (default 60) when `WOMPI_PRIVATE_KEY` is set; print "reconciliation disabled" otherwise; verify by starting the bridge with and without the key and reading its startup output.

## 6. On return

- [x] 6.1 Add `POST /api/payments/reconcile { transaction_id }` to `src/api/server.mjs`, answering `approved | declined | pending | not_found | disabled`; verify in `tests/api-reconcile.test.mjs` (child process + fake Wompi): forged id → `not_found`, nothing settled; no key → `disabled`.
- [x] 6.2 In `public/app.js`, on load read `?id=`, call the endpoint once, show the outcome in Spanish, drop `?id` with `history.replaceState`, refresh; verify with a Playwright spec in `tests/e2e/diner.spec.mjs` using `page.route` for approved, declined and pending.
- [x] 6.3 Settle the unrecorded 10:59 sandbox payment once by calling the endpoint with its transaction id (from the Wompi panel); verify with `npm run audit` and the KDS.

## 7. Docs and full verification

- [x] 7.1 Add `WOMPI_PRIVATE_KEY`, `WOMPI_API_URL`, `WOMPI_RECONCILE_SECONDS` to `.env.example` and a "Reconciliation" paragraph to README.md.
- [x] 7.2 Stop `npm run worker`, then run `npm run test:all`; all green.
- [x] 7.3 Live sandbox test: pay with the webhook URL deliberately wrong in the Wompi panel; verify the round reaches the KDS via on-return, and in a second payment (phone closed before return) via the periodic check within one minute.
