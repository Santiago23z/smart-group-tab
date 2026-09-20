# Tasks

## 1. Baseline

- [x] 1.1 Record the green baseline before touching anything: `npm run db:reset && npm run test:all`. Expected 147 (38 schema, 88 node, 12 browser, 9 audit). Note the count so any later drop is visible rather than inferred.
- [x] 1.2 Confirm the starting condition this change exists to fix: run `npm run demo`, then `select channel, status, attempts from dispatches` and verify two rows sit at `pending`/`0` with nothing delivering them.

## 2. The kitchen ticket

- [x] 2.1 Create `supabase/migrations/20260920000200_dispatch_ticket.sql` with a function returning one `jsonb` kitchen ticket for a round: venue name, table label, round number, and the round's `active` items with quantity, product name and the nickname that ordered each. Select the fields explicitly — no `to_jsonb` of a whole row that could later start carrying money. Verify by calling it for a dispatched round from the demo and reading the output.
- [x] 2.2 Verify the ticket excludes voided items: void an item while the round is draft, close and dispatch the round, and confirm the voided item is absent from the ticket.
- [x] 2.3 Verify no financial field can appear: assert over the returned `jsonb` that no key matches amount, total, owed, balance, share, tip or reference, at any depth. Add this as a check in `scripts/verify-schema.mjs` so it holds for every future edit of the function.
- [x] 2.4 Run `npm run verify:schema` and confirm the chain still applies with the new migration.

## 3. Decisions, as plain functions

- [x] 3.1 Create `src/worker/backoff.mjs`: given an attempt count, a base, a cap and a jitter source, return a delay. No clock, no randomness it does not receive. Verify with unit tests that the curve grows, saturates at the cap, and is deterministic when the jitter source is fixed.
- [x] 3.2 Create `src/worker/outcome.mjs`: given a delivery result and the row's current attempt count, decide `delivered`, `retry` (with its next attempt time) or `failed`. Verify with unit tests covering success, a failure below the ceiling, and the failure that crosses it.
- [x] 3.3 Create `src/worker/deliver.mjs` holding the HTTP delivery call, with the URL and the payload passed in. Verify it can be exercised against a stub server with no database involved.
- [x] 3.4 Add these tests to `tests/` following the existing naming, and verify `npm test` runs them without a `DATABASE_URL`.

## 4. The worker shell

- [x] 4.1 Create `src/worker/server.mjs` (or `worker.mjs`) as a shell holding only the loop, the connection and the configuration — every decision delegated to section 3, the way `src/wompi/server.mjs` delegates to `signature`/`events`/`handler`. Verify by confirming the shell contains no backoff arithmetic and no outcome branching.
- [x] 4.2 Implement the claim as its own transaction: `select ... where status = 'pending' and next_attempt_at <= now() order by next_attempt_at for update skip locked limit 1`, read the ticket, then **commit before the HTTP call**. Verify with `EXPLAIN` that the claim uses `dispatches_due_idx`.
- [x] 4.3 Implement the outcome write as a second transaction. Verify by instrumenting a run and confirming no transaction is open while the HTTP request is in flight — this is the single most important boundary in the change, because a lock held across a kitchen device's socket is how a hung display becomes a stuck queue.
- [x] 4.4 Require `DISPATCH_KDS_URL` and `DISPATCH_PRINT_URL` at startup; a missing one is a crash, not a warning. Verify the process exits non-zero with a message naming the variable, the way the Wompi server does for a missing events secret.
- [x] 4.5 Add `npm run worker` to `package.json` and document the variables in `.env.example`. Verify `npm run worker` starts and drains the two rows left by `npm run demo`.

## 5. Integration: it actually delivers

- [x] 5.1 Write an integration test with a stub HTTP destination and a real database: a dispatched round's `kds` and `print` rows both reach `delivered` with a delivery timestamp, and the stub received a ticket naming the right table and items. Verify it fails if the worker is not run.
- [x] 5.2 Test retry: a stub that refuses once then accepts. Verify the row goes from `pending` with `attempts = 1` and a recorded `last_error` to `delivered`, and that `next_attempt_at` moved further out after the failure.
- [x] 5.3 Test terminal failure: a stub that always refuses. Verify the row reaches `failed`, retains its last error, and is not attempted again.
- [x] 5.4 Verify the retry tests assert on the backoff *decision*, not by waiting real seconds. A test that sleeps to observe a retry is slow, flaky, and usually proves only that one retry happened.

## 6. Integration: it survives concurrency and crashes

- [x] 6.1 Test that two workers draining the same queue deliver each row exactly once and neither blocks on the other. **Corrected during implementation:** the first version raced once and went green against a claim with no lease while two workers really delivered two rows five times. It now races 25 rounds, and the mutation table is: dropping the lease -> 5 duplicates in 25 races; dropping `skip locked` -> caught only by a dedicated liveness test, because correctness comes from the lease, not from `skip locked`.
- [x] 6.2 Test the at-least-once contract explicitly: simulate a worker that delivers and then dies before recording. Verify the row is still `pending`, that a second run re-delivers it, and that both deliveries carry the same round and channel so a receiver can collapse them.
- [x] 6.3 Verify the worker never takes the round lock: with a worker mid-delivery against a stub that hangs, confirm `reserve_contribution` on that same round still completes. This is the failure that would turn a slow kitchen display into a payment outage.

## 7. Terminal failure reaches a human

- [x] 7.1 On terminal failure, move the round's session to `requires_staff_attention` unless it is already `closed`. Verify with a test covering both: an open session gets flagged, a closed one stays closed.
- [x] 7.2 Verify the round is left alone: after terminal failure the round is still `paid_and_dispatched` with its `dispatched_at` intact. `rounds_dispatched_at_matches_status` makes the alternative a lie about the ledger, and the constraint should be observed to hold rather than assumed.

## 8. A stopped worker is visible

- [x] 8.1 Add a check to `scripts/audit-invariants.mjs` reporting dispatch rows `pending` well beyond a reasonable delivery time. Verify it stays green on a freshly drained queue and reports when rows are left undelivered. **Corrected during implementation:** a second check auditing `failed` rows was added and then removed — a terminal failure is a correctly recorded incident, not a violated invariant, and auditing it would leave the audit permanently red in any venue whose kitchen display has ever failed. Terminal failure reaches a human through the session flag (7.1).
- [x] 8.2 Verify the check would have caught today's condition: run `npm run demo` without the worker and confirm the audit reports the two undelivered rows rather than passing.

## 9. Close out

- [x] 9.1 Run `npm run db:reset && npm run test:all` and verify the count matches the task 1.1 baseline plus the new tests, with zero audit violations.
- [x] 9.2 Re-run the documented `lock_round` mutation and verify the money path is still protected after a new writer of `sessions` was added. Caught: 5 failures with `FOR UPDATE` removed, 122/122 restored. Also surfaced that `npm test` had to move to `--test-concurrency=1`: a worker drains the whole queue by design, so with test files in parallel it ate dispatch rows other files were still creating.
- [x] 9.3 Update `README.md`: the Status table (phase 4), the "Still missing" list, and how to run the worker. Verify the claim that the kitchen never hears anything is no longer left standing.
- [x] 9.4 Verify the change validates: `openspec validate add-dispatch-worker --strict`.
