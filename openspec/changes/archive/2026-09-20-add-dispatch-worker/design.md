# Design

## Context

See `proposal.md` — Why. Four things about the existing system shape this.

**The outbox table is already the right shape.** `dispatches` has `attempts`, `next_attempt_at`,
`last_error`, `delivered_at`, `unique (round_id, channel)`, the check
`(status = 'delivered') = (delivered_at is not null)`, and the partial index
`dispatches_due_idx on (next_attempt_at) where status = 'pending'` — which is literally the
worker's claim query. `dispatch_status` already carries an unused `failed`. Nothing in the
schema needs adding.

**`lock_round`'s `FOR UPDATE` is the only mutual-exclusion mechanism in the system**, and it
serialises per round. The worker must not take it: it would put an HTTP call inside the same
lock that money RPCs contend on, so a slow kitchen display would block payments at that table.
The worker's mutual exclusion is per *dispatch row* and is a different, non-overlapping lock.

**The Wompi adapter is the pattern for external I/O.** `signature.mjs`, `events.mjs` and
`handler.mjs` have no HTTP and no database in them; `server.mjs` is a shell. That is what lets
the whole adapter be tested without a server, and it is why moving it to an Edge Function is a
shim rather than a rewrite. The worker follows it.

**Everything that runs today is request-scoped.** This is the first component that runs in a
loop, outside a transaction, and can be killed mid-flight.

## Goals / Non-Goals

**Goals:**

- Drain the outbox correctly under several concurrent workers and under a process that dies at
  any point.
- Keep every decision — what is due, how long to back off, whether this attempt was terminal,
  what the ticket contains — in plain functions testable without a socket.
- Make a stopped worker visible.

**Non-Goals:**

- Rendering the ticket. What receives the POST is the KDS change.
- Any change to the money RPCs, the enqueue behavior, or an existing migration.
- Exactly-once delivery. It is not achievable and the spec says so.
- A real printer integration. `print` gets a destination; whether that destination is ESC/POS
  or a log is a configuration question, not a design one.

## Decisions

### Claim with `for update skip locked` **and a lease**, one row at a time

```sql
select * from dispatches
 where status = 'pending' and next_attempt_at <= now()
 order by next_attempt_at
   for update skip locked
 limit 1;

update dispatches set next_attempt_at = now() + <lease> where id = <claimed>;
```

**The lease is load-bearing, and the first draft of this design was wrong to omit it.** A row
lock is released at `commit`, and the claim commits *before* the HTTP call — that is the whole
point of the transaction boundaries below. So the lock protects a window of microseconds while
the delivery window is hundreds of milliseconds, and in between the row sits `pending` and
unlocked for any other worker to take.

This was not theoretical. Two workers against one released round delivered its two rows **five
times**, one channel three times over. `skip locked` alone gives no mutual exclusion across a
delivery.

Pushing `next_attempt_at` into the future while the row lock is still held takes the row out of
the claim predicate for the length of the lease.

**`skip locked` is kept, and mutation testing says it is not what makes this correct.** Removing
it leaves every other test in the suite green: a worker without it blocks until the holder
commits, then Postgres re-evaluates the row, finds `next_attempt_at` now in the future, and
returns nothing. Correctness comes from the lease. What `skip locked` buys is liveness — a
worker that waits behind a held row is a worker not draining the rest of the queue — and that
property gets its own test rather than being assumed from the other ones passing.

| Mutation | Caught? | What it means |
|---|---|---|
| Claim drops the lease | yes, 5 duplicates in 25 races | The lease is what excludes concurrent workers |
| Claim drops `skip locked` | yes, by one dedicated test only | Liveness, not correctness |

The first row is why the concurrency test repeats 25 times. Its first version raced once, went
green against a claim with no lease at all, and two workers were really delivering two rows five
times — the same lesson `lock_round`'s races already record.

**The lease must be longer than the delivery timeout.** A lease that can expire while its own
POST is still in flight re-creates exactly the duplicate it exists to prevent. The delivery
timeout is the ceiling on an attempt, so the lease is derived from it rather than tuned
separately.

**Claim one row per transaction, not a batch.** A batch holds locks for the duration of every
HTTP call in it, so one slow destination stalls rows that a second worker could be delivering.
Contention here is a handful of rows per table per night; there is nothing to amortise.

**Alternative considered: a status column transition (`pending → claimed`).** Rejected, and the
lease is what lets it be rejected honestly. A `claimed` status strands rows when a worker dies
and needs a reaper with its own staleness timeout — a second correctness problem. A lease
expires through the passage of time alone: nothing has to run on schedule for a killed worker's
row to become deliverable again. That is the same reasoning the reservation TTL already uses
(D8), where correctness depending on a cron would have meant a late cron was overcollection.

**Alternative considered: hold the claim transaction open across the HTTP call.** Rejected. It
would give exclusion for free, and it is how a hung socket to a kitchen device becomes a stuck
queue with an idle-in-transaction backend holding a lock indefinitely.

### The transaction boundary: claim, commit, deliver, record

```
  tx1:  claim (for update skip locked) -> read the ticket payload -> COMMIT
                                |
                         HTTP POST  (no transaction open, no locks held)
                                |
  tx2:  record the outcome (delivered | retry | failed)
```

The lock is released before the HTTP call. Holding a row lock across a network call to a device
in a kitchen is how a hung socket becomes a stuck queue.

This ordering is what makes delivery at-least-once: dying between the POST and `tx2` re-delivers
on restart. The alternative ordering — mark delivered, then POST — turns the same crash into
*at-most-once*, which loses the ticket entirely. Given the choice between a duplicate ticket and
a missing one for food that has been paid for, the duplicate is the only acceptable failure, and
`unique (round_id, channel)` gives the receiver what it needs to collapse it.

### Backoff: exponential with a cap, computed by a pure function

`next_attempt_at = now() + min(base * 2^attempts, cap)`, with a small random jitter so several
rows failing against the same dead destination do not retry in lockstep.

The function takes an attempt count and returns a delay. No clock, no database, no randomness
source it does not receive — so the backoff curve is unit-testable rather than something that
has to be observed over minutes.

### Terminal failure flags the session, and must not touch the round

After a bounded number of attempts the row becomes `failed`, and the round's session moves to
`requires_staff_attention`.

**The round is deliberately left alone.** `rounds_dispatched_at_matches_status` enforces
`(status = 'paid_and_dispatched') = (dispatched_at is not null)`, so moving a dispatched round
to `requires_staff_attention` would require clearing `dispatched_at` — making the ledger claim
the round was never released, when it was paid and released and only the delivery failed. The
constraint is right and the instinct to reuse the round's staff-attention state is wrong.

The session flag reuses the value `confirm_webhook` already writes for money that could not be
placed. Both mean the same thing to the person who acts on it: go look at this table. The
distinction between "money problem" and "food problem" lives in the rows, not in a second enum
value.

### The ticket is built in the database, by its own function

A `select` returning one `jsonb` for a round, in the shape of `tableState` but with the money
removed and the participant nicknames resolved.

It goes in a migration rather than being assembled in Node for the same reason nothing else
computes money in Node: one place decides what a round contains, and the worker stays a shell
around decisions made elsewhere.

**Money is excluded structurally, not by convention.** The function selects the fields it
returns; there is no object spread that could quietly start carrying `owed_amount` when
something upstream changes shape.

### Destinations are configured per channel, with no default

`DISPATCH_KDS_URL` and `DISPATCH_PRINT_URL`. A missing URL for a channel that has pending rows
is a startup failure, not a warning — the same call the Wompi adapter makes about a missing
events secret. A worker that silently does nothing for a channel reproduces exactly the bug this
change exists to fix.

For now `print` points at a stub. That is a configuration value, and the worker cannot tell the
difference.

### Detecting a stopped worker belongs in the audit

`npm run audit` already proves invariants over every row that exists, and it is the tool that
found the worst defect in this repo. A check for dispatch rows pending well beyond a reasonable
delivery time fits there: it is a statement about the data, checkable without instrumenting the
worker.

**Alternative considered: a heartbeat table the worker writes to.** Rejected for now — it adds a
table and a staleness threshold to tune, and answers a narrower question than "is anything
undelivered", which is what actually matters.

## Risks / Trade-offs

**A duplicate ticket reaches the kitchen** → Inherent to at-least-once; the spec states it and
`unique (round_id, channel)` is the key the receiver deduplicates on. The KDS change must be
built against that contract rather than assuming exactly-once.

**The worker holds a row lock across an HTTP call by accident** → The single most likely way to
turn this into a payment outage, because a stuck lock on `dispatches` is harmless but the same
mistake inside `lock_round` is not. The transaction boundaries are the design; a test should
prove a second worker can still claim while a first is mid-delivery.

**Backoff tested only by observing it** → Keep the calculation pure and test the curve directly.
A retry test that waits real seconds is slow, flaky, and usually only proves that one retry
happened.

**A destination that returns 200 without accepting the ticket** → Out of scope here and worth
naming: HTTP success is the only signal the worker has. A receiver that acknowledges and drops
is indistinguishable from one that works, which is another reason the receiving end has to be
designed deliberately in the KDS change.

**The worker becomes the thing nobody runs** → The audit check is the mitigation, and it is the
reason that check is part of this change rather than a follow-up.

## Migration Plan

1. Migration adding the ticket function. Nothing else in the schema changes.
2. Decision functions (claim SQL, backoff, outcome) with unit tests that need neither a socket
   nor a database.
3. The worker shell and `npm run worker`.
4. Integration tests against a real database and a stub HTTP destination: success, retry,
   terminal failure, two workers, and a crash between POST and record.
5. Audit check for overdue pending rows.

**Rollback.** Stop the worker. Rows stay `pending` and are delivered whenever it runs again —
which is the property the outbox exists for, and makes this the cheapest component in the system
to withdraw.

## Open Questions

- The attempt ceiling and the backoff cap are operational numbers, not design ones. Reasonable
  starting values are fine; the venue's tolerance for a late ticket decides them, and they are
  configuration rather than structure.
