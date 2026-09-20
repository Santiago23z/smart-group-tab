// Smart Group Tab — the outbox queries.
//
// Why the transaction boundaries are what they are:
//
//   tx1: claim (for update skip locked) -> read the ticket -> COMMIT
//                            |
//                     HTTP POST   <- no transaction open, no locks held
//                            |
//   tx2: record the outcome
//
// The lock is released before the network call. Holding a row lock across a
// socket to a device in a kitchen is how a hung display becomes a stuck queue.
//
// This ordering is also what makes delivery AT-LEAST-ONCE: dying between the
// POST and tx2 re-delivers on restart. The other ordering — mark delivered,
// then POST — turns the same crash into at-most-once, which loses the ticket
// entirely. For food that has already been paid for, a duplicate ticket is the
// only acceptable failure, and `unique (round_id, channel)` is what lets the
// receiver collapse it.
//
// The worker must NEVER take lock_round(). That row lock is the only mutual
// exclusion in the system and every money RPC contends on it; putting an HTTP
// call behind it would make a slow kitchen display into a payment outage.
// Claiming locks a `dispatches` row, which nothing else in the system touches.

/**
 * How long a claimed row stops being due while it is being delivered.
 *
 * MUST exceed the delivery timeout. A lease that can expire while its own POST
 * is still in flight hands the row to a second worker and re-creates the exact
 * duplicate it exists to prevent — so it is derived from the timeout rather
 * than tuned next to it and allowed to drift underneath it.
 */
export const leaseMsFor = (timeoutMs) => Math.max(timeoutMs * 3, 30_000)

/**
 * Claim one due dispatch and read its ticket, in a single transaction that is
 * committed before anything is delivered.
 *
 * TWO mechanisms, doing two different jobs:
 *
 *   `for update skip locked` stops two workers blocking on each other during
 *   this transaction. A worker that cannot take a row moves past it.
 *
 *   The lease is what actually excludes them across the delivery. The row lock
 *   is released at commit — which happens before the HTTP call — so on its own
 *   it protects microseconds while a delivery takes hundreds of milliseconds,
 *   and any other worker would claim the still-`pending` row and send the same
 *   ticket again. Measured: two workers, one round, five deliveries of two rows.
 *
 * Pushing `next_attempt_at` forward takes the row out of the claim predicate
 * for the length of the lease. If this worker dies mid-delivery the lease simply
 * expires and the row becomes deliverable again — no reaper, no stranded
 * `claimed` state, nothing that has to run on time for correctness, which is the
 * same reasoning the reservation TTL uses.
 *
 * One row per transaction, not a batch — a batch holds its locks for the length
 * of every HTTP call in it, so one slow destination stalls rows another worker
 * could be delivering. Contention here is a few rows per table per night.
 */
export async function claimOne(client, { leaseMs = leaseMsFor(10_000) } = {}) {
  await client.query('begin')
  try {
    const { rows } = await client.query(`
      select d.id, d.round_id, d.channel, d.attempts,
             dispatch_ticket(d.round_id) as ticket
        from dispatches d
       where d.status = 'pending'
         and d.next_attempt_at <= now()
       order by d.next_attempt_at
         for update of d skip locked
       limit 1`)

    if (rows[0]) {
      // Still inside the transaction, still holding the row lock: no other
      // worker can be between the select and this update.
      await client.query(
        `update dispatches
            set next_attempt_at = now() + make_interval(secs => $2::numeric / 1000)
          where id = $1`,
        [rows[0].id, leaseMs])
    }

    await client.query('commit')
    return rows[0] ?? null
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }
}

/** The outcome write. A separate transaction, opened after delivery returned. */
export async function record(client, dispatchId, outcome) {
  await client.query('begin')
  try {
    if (outcome.kind === 'delivered') {
      await client.query(
        `update dispatches
            set status = 'delivered', delivered_at = now(), last_error = null
          where id = $1`, [dispatchId])

    } else if (outcome.kind === 'retry') {
      await client.query(
        `update dispatches
            set attempts = $2,
                next_attempt_at = now() + make_interval(secs => $3::numeric / 1000),
                last_error = $4
          where id = $1`, [dispatchId, outcome.attempts, outcome.delayMs, outcome.error])

    } else {
      await client.query(
        `update dispatches
            set status = 'failed', attempts = $2, last_error = $3
          where id = $1`, [dispatchId, outcome.attempts, outcome.error])

      // Paid food the kitchen never received, and no amount of retrying will
      // fix it now. The round is deliberately NOT touched: the constraint
      // rounds_dispatched_at_matches_status ties paid_and_dispatched to
      // dispatched_at, so moving it would mean clearing that timestamp and
      // making the ledger claim a round was never released when it was paid and
      // released. The delivery failed, not the round. The session is where a
      // human is told to come look at this table — the same signal
      // confirm_webhook raises for money it could not place.
      await client.query(
        `update sessions s
            set status = 'requires_staff_attention'
           from dispatches d
                join rounds r on r.id = d.round_id
          where d.id = $1
            and s.id = r.session_id
            and s.status <> 'closed'`, [dispatchId])
    }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }
}
