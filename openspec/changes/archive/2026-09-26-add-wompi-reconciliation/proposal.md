# Proposal

## Why

The ledger only learns about a Wompi payment from the webhook. If that webhook never arrives
(events URL not saved, tunnel down, Wompi outage), an approved payment is invisible: the money
moved, the round never fires, and the app keeps offering the same reservation until Wompi
refuses it as "referencia ya usada". This happened in the first live sandbox test (the
$144.720 payment at 10:59 is still unrecorded). I3 promises no lost webhooks; today it only
holds if the webhook is delivered at least once.

## What Changes

- The server can ask Wompi directly about a transaction, using the merchant's private key, and
  settle what it learns through the same `confirm_webhook` path and event id a webhook would
  use. A webhook arriving before or after is a harmless duplicate.
- **On return**: the checkout sends the diner back to the table page. Wompi appends the
  transaction id; the page asks the server to check it at once, so the table does not wait for
  the webhook.
- **Periodic check**: every minute, for each reservation whose checkout was issued in the last
  24 hours and is not yet settled or released, the server asks Wompi for transactions carrying
  that reservation's reference and settles any final outcome it finds.
- Every checkout issued is recorded, so the periodic check only looks at reservations a diner
  actually took to Wompi.
- New secret `WOMPI_PRIVATE_KEY`. Without it, reconciliation is off and the app says so at
  startup; nothing else changes.

## Capabilities

### New Capabilities
- `payment-reconciliation`: how a Wompi payment outcome reaches the ledger without the webhook,
  both on the diner's return and by periodic check, and why it can never double-count.

### Modified Capabilities
None. Settlement rules (`round-lifecycle`, `session-lifecycle`) are reused unchanged:
reconciliation feeds the same function, so late money is still credited and flagged exactly as
those specs say.

## Impact

- **DB**: new migration with a `checkout_attempts` table (one row per issued checkout) and the
  query that selects reservations due for a check.
- **Code**: `src/wompi/` gains a transaction lookup client and a reconcile function;
  `src/wompi/intent.mjs` records issued checkouts and sets the return URL; the Wompi bridge runs
  the periodic loop; `src/api/server.mjs` gains `POST /api/payments/reconcile`;
  `public/app.js` reads `?id=` on return.
- **Config**: `WOMPI_PRIVATE_KEY`, `WOMPI_API_URL` (sandbox by default),
  `WOMPI_RECONCILE_SECONDS` (60).
- **External**: first outbound calls from our server to the Wompi API. No new dependencies
  (`fetch` is built into Node).
- **Verified 2026-09-26**: both lookups work against the sandbox with the private key — by id
  (`GET /v1/transactions/{id}`, documented) and by reference
  (`GET /v1/transactions?reference=…`, undocumented but confirmed).
