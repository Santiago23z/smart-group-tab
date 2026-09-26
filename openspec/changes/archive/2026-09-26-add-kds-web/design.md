# Design

## Context

- The worker (`src/worker/`) POSTs `dispatch_ticket(round_id)` to `DISPATCH_KDS_URL` and
  `DISPATCH_PRINT_URL`, with `x-dispatch-round` and `x-dispatch-channel` headers, and treats any
  2xx as delivered. It sends no credential today.
- Delivery is at-least-once; `(round_id, channel)` is the receiver's idempotency key.
- Every existing server is a thin shell over plain functions (`src/wompi/`, `src/worker/`), and no
  business logic lives in Node: decisions are SQL functions. The diner PWA polls `/api/state`.
- Alert sources already exist in the schema: `sessions.status`, `rounds.status`,
  `contributions.applied_to_prepaid_balance`, `dispatches.status/last_error/next_attempt_at`.
  `scripts/audit-invariants.mjs` already detects stale pending dispatches (15 min).

## Goals / Non-Goals

**Goals:** the demo ends on a kitchen screen fed by the real worker over HTTP; staff see every
table that needs them and whether the queue is moving.

**Non-Goals:** staff accounts or roles (a shared token is enough for the MVP), resolving alerts,
D2/D17 actions, real printers, realtime push (polling stays, as in the diner PWA).

## Decisions

**1. A separate process, `src/kds/server.mjs` on port 8790 (`npm run kds`).** It is the worker's
destination for both channels (`/ingest/kds`, `/ingest/print`) and serves the screen at `/kds`.
Pure functions in `src/kds/` (`ingest.mjs`, `auth.mjs`) do the checking; the server is a shell.
*Alternative:* add routes to `src/api/server.mjs`. Rejected: that server is the diner's, it runs
with simulated payments on, and mixing staff routes into it widens what a diner-facing process can
reach. Port 8790 is what the README already documents for the worker.

**2. Tickets are stored in Postgres, table `kitchen_tickets`.**
`round_id` (primary key, FK to `rounds`), `ticket jsonb`, `first_received_at`,
`last_received_at`, `receive_count`, `done_at`. Ingest is
`insert ... on conflict (round_id) do update set last_received_at = now(), receive_count = receive_count + 1`
— the stored ticket and `done_at` are never overwritten, which is what makes a repeat show one
order and never reopen a done one. Only the `kds` channel is stored; `print` is acknowledged and
logged.
*Alternative:* keep tickets in memory. Rejected: a KDS restart would empty the screen while every
dispatch says `delivered` — paid food silently lost, the exact failure the outbox exists to prevent.
*Trade-off:* the KDS shares the database with everything else. The HTTP boundary is kept anyway,
so the KDS can move to its own device and store later without touching the worker.

**3. Two shared tokens, both required at startup.**
- `DISPATCH_TOKEN`: the worker sends `authorization: Bearer <token>`; the KDS compares with
  `crypto.timingSafeEqual`. Missing on either side = refuse to start (same stance as the Wompi
  secret and the worker's URLs).
- `KDS_STAFF_TOKEN`: required on `/kds/api/*`. The screen is opened once as `/kds#token=...`; the
  page moves it to `localStorage`, clears the hash, and sends it as a bearer header. A hash, not a
  query string, so it never reaches server logs.
The static HTML carries no data and is served without a token.
*Alternative:* staff logins. Out of scope for the MVP; the tokens are the seam where they go later.

**4. Alerts are one SQL function, `staff_alerts(p_stall interval)`, returning jsonb.** It derives
per session in `requires_staff_attention` the reasons from the spec: credited contributions
(sum of `order_amount + tip_amount`), failed dispatches (channel + `last_error`), rounds in
`requires_staff_attention` with no credited contribution ("collection stalled"), else `unknown`.
It also returns the stall warning: count of `pending` dispatches with
`next_attempt_at < now() - p_stall`, and the oldest age. Counting from `next_attempt_at` (not
`created_at`) is what keeps rows legitimately waiting out their backoff from counting.
Default threshold 2 minutes (`KDS_STALL_MINUTES`): the worker polls every 2s and the backoff caps
near a minute, so two minutes past due means nobody is draining.

**5. Acknowledgement snapshots the reasons, not a time.** Table `staff_alert_acks`
(`session_id` PK, `acknowledged_at`, `reason_keys text[]`). Each reason has a stable key
(`contribution:<id>`, `dispatch:<id>`, `round:<id>`). An alert is acknowledged only if all its
current keys are in the snapshot, so a new incident un-acknowledges it.
*Alternative:* compare timestamps. Rejected: `dispatches` has no failure timestamp, and adding one
to the worker's table for a UI concern is backwards.

**6. The screen polls `/kds/api/state` every 3 seconds** and re-fetches on focus, like the diner
PWA. Layout for a landscape tablet, large type; tickets oldest-first with a waiting timer computed
from `first_received_at` using the server's clock offset.

**7. Worker change is minimal:** `deliver()` takes a `token` and adds the header; `drain()` passes
it through; `server.mjs` refuses to start without `DISPATCH_TOKEN`. A 401 is already a non-2xx, so
retry/fail handling needs no change — only a test proving it.

## Risks / Trade-offs

- [Shared tokens leak or are shared around the venue] → They are per-deployment env vars and
  rotated by restarting; staff accounts are the planned replacement.
- [A ticket that 200s but is not stored] → Ingest answers 2xx only after the insert commits; any
  database error is a 5xx, so the worker retries.
- [FK to `rounds` rejects a ticket for an unknown round] → Answered 422; the worker records it as
  a failed attempt with the reason, which is correct: a round the database does not know is not
  something to cook.
- [Polling load] → One screen per venue at 3s is negligible at MVP scale.

## Migration Plan

One additive migration (`kitchen_tickets`, `staff_alert_acks`, `staff_alerts()`); no change to
existing tables. New env vars documented in `.env.example`. Rollback: stop `npm run kds`; the
worker's rows stay `pending` and retry, nothing is lost.
