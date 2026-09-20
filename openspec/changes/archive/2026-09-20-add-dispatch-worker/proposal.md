# Proposal

## Why

`confirm_webhook` and `close_round` write rows into `dispatches` when a round is released to
the kitchen, and nothing has ever read them. Every round the system has ever dispatched is
sitting in that table at `pending`, `attempts = 0`. The money moved, the ledger is correct,
the invariants hold — and the kitchen has never heard about a single order.

This is the last thing between the current state and the §6 MVP demo. It is also the half of
I2 that is not yet built: the schema and the state transition guarantee a dispatch is
*recorded* exactly once, but nothing guarantees it is *delivered*.

## What Changes

**A worker process that drains the outbox.** A separate Node process claims due rows, delivers
them over HTTP, and records the outcome. It is the piece the `dispatches` table was shaped for:
`attempts`, `next_attempt_at`, `last_error` and the partial index `dispatches_due_idx` on
`next_attempt_at where status = 'pending'` are already exactly a worker's claim query.

- The worker SHALL claim rows with `for update skip locked`, so several workers can run without
  two of them delivering the same row.
- Delivery is an **HTTP POST to a configured endpoint per channel**. The worker does not know
  or care what consumes it — a KDS web app, a print service, a venue's POS. That keeps this
  change independent of the KDS UI, which is its own step, and lets the worker be tested today
  against a stub with no KDS in existence.
- The payload is a kitchen ticket built in the database: venue, table label, round number, and
  the round's active items with quantities and who ordered them. No money.
- Failures back off exponentially with a cap. After a bounded number of attempts the row goes
  to `failed` — the value already in `dispatch_status` and never used — carrying its last error.
- **A terminal dispatch failure flags the session** as `requires_staff_attention`. A `failed`
  row nobody queries is not an alert, and paid food the kitchen never received is an
  operational emergency, not something to retry quietly forever.

**Both channels are delivered.** `kds` and `print` rows are both enqueued today, and
`npm run audit` asserts exactly two per dispatched round. The worker handles both; `print`
points at a stub destination until a real printer exists. The alternative — delivering only
`kds` — would leave `print` rows pending forever, which is indistinguishable from a stuck
delivery and destroys the one signal the worker exists to give.

**Not in this change:** the KDS Web UI, staff actions, `close_session`. The worker delivers to
whatever URL it is given; what renders the ticket is the next step.

## Capabilities

### New Capabilities

- `dispatch-delivery`: How a recorded dispatch reaches the kitchen — claiming, delivery,
  retry and backoff, terminal failure, and the at-least-once contract the receiving end must
  be built against.

### Modified Capabilities

- `session-lifecycle`: gains a requirement that a dispatch which cannot be delivered flags the
  session for staff. This is a new concern rather than a change to existing behavior: the
  session already gets flagged for money that cannot be placed, and undelivered food is the
  same class of "a human has to look at this table".

## Impact

**New code.** A worker entry point (`npm run worker`) plus the decision logic it runs on. The
Wompi adapter is the pattern to follow: `signature.mjs`, `events.mjs` and `handler.mjs` contain
no HTTP and no database, which is what lets them be tested without either, while `server.mjs` is
a shell. The claim query, the backoff calculation and the outcome decision belong in the same
kind of plain functions.

**New database function.** A read that builds the kitchen ticket payload for a round. Nothing
existing produces it; `tableState` in `src/api/server.mjs` is the diner's shape and includes
money, which the kitchen has no business seeing.

**`sessions`.** A new writer of `requires_staff_attention`, alongside `confirm_webhook`.

**No change to** the money RPCs, the enqueue behavior, the enum definitions, or any existing
migration. The worker only ever writes `dispatches` rows and the session flag.

**Risk.** The worker is the first component in the system that runs outside a request and
outside a transaction. It is also the first place where a crash at the wrong instant produces
a visible duplicate: delivering and then dying before marking `delivered` re-delivers on
restart. That is inherent — no protocol makes an external call and a local write atomic — so
the contract is **at-least-once**, and the spec says so explicitly rather than implying
otherwise. `unique (round_id, channel)` is the natural idempotency key for whatever receives it.

**Operational risk.** A worker that is not running is invisible: rows accumulate at `pending`
and everything else stays green, which is exactly today's situation. `npm run audit` should be
able to see it.
