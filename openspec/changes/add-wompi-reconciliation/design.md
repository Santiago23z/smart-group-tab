# Design

## Context

- Settlement is `confirm_webhook(provider, event_id, reference, outcome, amount, payload,
  signature_verified)`. Its first statement inserts `(provider, event_id)` into `webhook_events`;
  a repeat returns `duplicate_event` before touching the ledger.
- The webhook path (`src/wompi/handler.mjs`) derives `event_id = "<tx.id>:<tx.status>"` in
  `parseTransactionEvent` (`src/wompi/events.mjs`), which also validates currency, amount and
  reference and converts cents to pesos.
- Checkouts are built by `createPaymentIntent` (`src/wompi/intent.mjs`), reached from two places:
  the diner app (`POST /api/payments/intent`, `src/api/server.mjs`) and the bridge
  (`POST /payments/intent`, `src/wompi/server.mjs`). Nothing records that a checkout was issued.
  `redirectUrl` comes from `WOMPI_REDIRECT_URL` and is unset by default, so today the diner stays
  on Wompi's result page.
- Wompi documents `GET /v1/transactions/{id}` (private key) and that Web Checkout redirects to
  `redirect-url?id=<transaction id>`. It does **not** document a lookup by reference.
- Reservations expire lazily: a lapsed hold keeps `status = 'active'`; no cron flips it.

## Goals / Non-Goals

**Goals:**
- One settlement path. Reconciliation is a second *source* of events, never a second
  implementation of settlement.
- Idempotency by construction: a lookup and a webhook for the same transaction and status produce
  the same `event_id`.

**Non-Goals:**
- Per-venue Wompi keys (one merchant account for now).
- Recovering money for references with no reservation (still recorded as `unknown_reference`,
  as for webhooks).
- Backfilling the 10:59 sandbox payment automatically. Its checkout predates the new table; it is
  settled once, by hand, through the on-return endpoint with its transaction id (task 6.3).

## Decisions

**D1 — Feed `confirm_webhook` through `parseTransactionEvent`.** The API returns
`{ data: <transaction> }`; the reconciler wraps it as `{ data: { transaction } }` and reuses the
parser, so `event_id`, units and validation are identical to the webhook by construction.
*Alternative*: a separate parser for API responses — rejected, two parsers can drift and then
the same payment gets two event ids and is counted twice.

**D2 — Mark the source in the payload; `signature_verified = true`.** The column means "we
believe this message". A response fetched by us over TLS with our private key is authenticated
as strongly as a signed event. The stored payload is `{ source: 'wompi_api', data: {...} }`, so
the record shows it came from a lookup (spec requirement).
*Alternative*: `false` — rejected, it would mark genuine money as untrusted.

**D3 — New table `reservation_checkouts`.** One row per reservation that reached Wompi:
`reservation_id` (pk, fk), `first_issued_at`, `last_issued_at`, `next_check_at`,
`check_count`, `last_outcome`. Upserted by `createPaymentIntent` when it returns `created`.
Due rows: reservation status `active` or `expired`, `first_issued_at > now() - 24h`,
`next_check_at <= now()`, claimed with `for update skip locked` so two bridges do not both call
Wompi for the same row. After each check `next_check_at = now() + interval`. RLS on, no grants to
`anon`/`authenticated`, like every ledger table.
*Alternative*: poll every `active` reservation of the last 24h — rejected, most never reach Wompi.

**D4 — Several transactions for one reference: processed as listed.** Declined attempts may
share a reference with a later approval. First planned as "approved first", but a mutation test
showed order is irrelevant: after a decline releases the hold, `confirm_webhook` still settles
the approval as ordered (the shares were not retaken). The test covering both orders stays.

**D5 — The periodic loop runs inside the Wompi bridge** (`npm run wompi`). It is already required
whenever Wompi is live and already holds the Wompi secrets. The loop logic is a plain function
(`reconcileDue(pool, { api, interval })`), so moving it to its own process later is a shim.
*Alternative*: a separate `npm run reconcile` like the dispatch worker — rejected for now, it is a
sixth process to start for the demo and one more to forget.

**D6 — On return: `POST /api/payments/reconcile { transaction_id }`** on the diner app. It calls
`GET /v1/transactions/{id}` (the documented endpoint) and runs the same reconcile function. It
answers `{ outcome: 'approved' | 'declined' | 'pending' | 'not_found' | 'disabled', result }`.
The page reads `?id=` on load, calls it once, shows the outcome, removes `?id` with
`history.replaceState`, then refreshes state.

**D7 — The return URL is built by the server, not sent by the device.** `createPaymentIntent`
gets the table's `qr_token` from the reservation and sets
`redirect-url = <origin>/t/<qr_token>`, where `<origin>` is `WOMPI_REDIRECT_URL` if set, else the
request's own origin (`x-forwarded-proto` / `host`). No device input reaches the URL.

**D8 — A small Wompi API client** (`src/wompi/api.mjs`): `getTransaction(id)`,
`findByReference(reference)`, base URL `WOMPI_API_URL` (default `https://sandbox.wompi.co/v1`),
`Authorization: Bearer <private key>`, 10 s timeout, injectable `fetchImpl`. Tests run against a
fake Wompi HTTP server; no test touches the network.

**D9 — Interval 60 s, window 24 h** (user decision), from `WOMPI_RECONCILE_SECONDS`.

## Decision gate (resolved 2026-09-26)

Verified against the sandbox with the private key, using the real approved transaction
`12201004-1790438748-56009`:

- `GET /v1/transactions?reference=<ref>` → 200, `{ "data": [ <transaction>, ... ] }` (array).
- `GET /v1/transactions/<id>` → 200, `{ "data": <transaction> }` (object).
- Without a key, the reference lookup answers 401 `INVALID_ACCESS_TOKEN`.
- The transaction carries `id`, `status`, `reference`, `amount_in_cents`, `currency` as the
  webhook does, **plus personal data** (email, phone, national id, device data).

**D10 — Store only what settlement needs.** Because of that personal data, the payload stored
for a lookup is trimmed to `id`, `status`, `reference`, `amount_in_cents`, `currency`,
`payment_method_type`, `created_at`, `finalized_at`, not the full response.

## Risks / Trade-offs

- [Reference lookup does not exist] → decision gate above.
- [Wompi's firewall 403s a `redirect-url` naming an IP or `localhost`] — found in the live test:
  the checkout never loaded. Probed 2026-09-26: `192.168.x`, `8.8.8.8`, `localhost`, `[::1]` →
  403; `example.com`, `mi-mac.local`, `http://` or `https://` → 200. Such an origin now gets no
  `redirect-url` (the checkout works, the periodic check covers it). For the return to work on a
  LAN demo, open the app by host name (`<mac>.local`) or set `WOMPI_REDIRECT_URL`.
- [An abandoned checkout costs 1 440 API calls per day at 60 s] → acceptable for the MVP; a
  backoff is the obvious later fix.
- [Private key leaks] → read only from env, never logged, never returned to the device; `.env`
  is gitignored.
- [Lookup and webhook race] → both hit the `webhook_events` unique key; one wins, the other gets
  `duplicate_event`.

## Migration Plan

New migration only (additive). Deploy: add `WOMPI_PRIVATE_KEY` to `.env`, restart `wompi` and
`web`. Rollback: unset `WOMPI_PRIVATE_KEY` — reconciliation turns off, webhooks work as before.
