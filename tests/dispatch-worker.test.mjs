// Smart Group Tab — the dispatch outbox worker, against a real database.
//
// tests/worker-decisions.test.mjs proves the retry policy without a database.
// This proves the parts that only mean anything with one: that the queue drains,
// that two workers do not deliver the same ticket twice, that a crash between
// the POST and the outcome write re-delivers rather than loses, and — the one
// that matters most — that no lock is held while an HTTP call is in flight.
//
// THIS FILE IS WHY `npm test` runs with --test-concurrency=1. A worker drains
// the whole queue by design — that is the production behaviour, not a shortcut —
// so with test files running in parallel it eats dispatch rows other files are
// still creating, and counts here go wrong. The isolation belongs in the test
// runner, not in a scope parameter on the worker that exists only for tests.
// The concurrency that matters is still exercised: every race in this suite is
// parallel *within* a test, which serialising files does not touch.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { makePool, createFixture } from './helpers.mjs'
import { drain } from '../src/worker/run.mjs'
import { claimOne } from '../src/worker/claim.mjs'
import { DEFAULTS } from '../src/worker/backoff.mjs'

const pool = makePool()

/** A destination whose behaviour each test decides. */
async function stub(handler) {
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      received.push({
        url: req.url,
        round: req.headers['x-dispatch-round'],
        channel: req.headers['x-dispatch-channel'],
        ticket: JSON.parse(body),
      })
      await handler(req, res, received.length)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    received,
    urls: { kds: `${base}/kds`, print: `${base}/print` },
    close: () => new Promise((r) => server.close(r)),
  }
}

const accepts = (req, res) => { res.writeHead(200); res.end('ok') }
const refuses = (req, res) => { res.writeHead(503); res.end('kitchen down') }

/**
 * The queue is global by design: drain() claims any due row in the database,
 * not this fixture's. An earlier version of this file dealt with that by
 * settling every pending row before each test — a destructive global UPDATE
 * that raced the tests it was meant to isolate and produced failures that
 * looked like lost deliveries.
 *
 * Tests against a shared queue must not mutate what they do not own. Nothing
 * here writes outside its own fixture; every assertion is scoped to the rows
 * this test created, and other rows in the queue are simply someone else's.
 */

/**
 * Park every dispatch this file does not own outside the due window.
 *
 * A worker drains the whole queue — that is the production behaviour — so other
 * test files' rows are claimed here too, and the counts stop meaning anything.
 * An earlier version settled them instead, with `status = 'delivered'`. That was
 * worse than untidy: it wrote a lie into the ledger, saying tickets had reached
 * a kitchen that never saw them, and it raced the very tests it was isolating.
 *
 * Pushing `next_attempt_at` out changes only WHEN a row is due, never whether it
 * was delivered, and it leaves the other file's data exactly as that file left it.
 */
async function parkForeignRows(keep = []) {
  await pool.query(
    `update dispatches set next_attempt_at = now() + interval '1 hour'
      where status = 'pending' and not (round_id = any($1::uuid[]))`,
    [keep])
}

/** Deliveries the stub saw for one round, and nobody else's. */
const mine = (received, roundId) => received.filter((r) => r.round === roundId)

/** True once none of this round's rows are waiting any more. */
async function settled(roundId) {
  const { rows } = await pool.query(
    `select count(*)::int as n from dispatches
      where round_id = $1 and status = 'pending'`, [roundId])
  return rows[0].n === 0
}

/** A round already released to the kitchen, with its two outbox rows. */
async function dispatchedRound(itemCount = 2) {
  const fx = await createFixture(pool, {
    participants: 2,
    items: Array.from({ length: itemCount }, () => ({ price: 10_000 })),
    status: 'locked_for_payment',
  })
  await pool.query(
    `update rounds set status = 'paid_and_dispatched', dispatched_at = now() where id = $1`,
    [fx.roundId]
  )
  await pool.query(
    `insert into dispatches (round_id, channel) values ($1, 'kds'), ($1, 'print')`,
    [fx.roundId]
  )
  await parkForeignRows([fx.roundId])
  return fx
}

const rowsFor = async (roundId) => (await pool.query(
  `select channel, status, attempts, last_error, delivered_at, next_attempt_at
     from dispatches where round_id = $1 order by channel`, [roundId])).rows

// ---------------------------------------------------------------------------
test('it delivers', async (t) => {
  await t.test('both channels of a released round reach the kitchen', async () => {
    const fx = await dispatchedRound(2)
    const s = await stub(accepts)
    const db = await pool.connect()
    try {
      await drain(db, { urls: s.urls })

      const rows = await rowsFor(fx.roundId)
      assert.deepEqual(rows.map((r) => r.status), ['delivered', 'delivered'])
      for (const r of rows) assert.ok(r.delivered_at, `${r.channel} has no delivery timestamp`)

      // print is not left behind: a channel stuck at pending forever is
      // indistinguishable from one that is failing, which destroys the only
      // signal an outbox gives.
      assert.deepEqual(mine(s.received, fx.roundId).map((r) => r.channel).sort(),
        ['kds', 'print'])
    } finally { db.release(); await s.close() }
  })

  await t.test('the ticket names the table and what to cook, with no money', async () => {
    const fx = await dispatchedRound(2)
    const s = await stub(accepts)
    const db = await pool.connect()
    try {
      await drain(db, { urls: s.urls })
      const { ticket } = mine(s.received, fx.roundId)[0]
      assert.equal(ticket.round_id, fx.roundId)
      assert.ok(ticket.table.label)
      assert.equal(ticket.items.length, 2)
      for (const item of ticket.items) {
        assert.ok(item.name)
        assert.ok(item.ordered_by)
        assert.equal(typeof item.quantity, 'number')
      }
      assert.ok(!JSON.stringify(ticket).match(/amount|owed|total|balance|tip/i),
        'the kitchen ticket must carry no money')
    } finally { db.release(); await s.close() }
  })

  await t.test('nothing is delivered before it is due', async () => {
    const fx = await dispatchedRound(1)
    await pool.query(
      `update dispatches set next_attempt_at = now() + interval '1 hour' where round_id = $1`,
      [fx.roundId])

    const s = await stub(accepts)
    const db = await pool.connect()
    try {
      await drain(db, { urls: s.urls })
      assert.equal(mine(s.received, fx.roundId).length, 0)
      assert.ok((await rowsFor(fx.roundId)).every((r) => r.status === 'pending'))
    } finally { db.release(); await s.close() }
  })
})

// ---------------------------------------------------------------------------
test('it retries', async (t) => {
  await t.test('a refusal keeps the row and pushes the next attempt out', async () => {
    const fx = await dispatchedRound(1)
    const s = await stub(refuses)
    const db = await pool.connect()
    try {
      const before = (await rowsFor(fx.roundId))[0].next_attempt_at
      await drain(db, { urls: s.urls })

      const rows = await rowsFor(fx.roundId)
      for (const r of rows) {
        assert.equal(r.status, 'pending', 'a refused row must stay deliverable')
        assert.equal(r.attempts, 1)
        assert.match(r.last_error, /503/)
        assert.ok(r.next_attempt_at > before, 'the next attempt was not pushed out')
        assert.equal(r.delivered_at, null)
      }
    } finally { db.release(); await s.close() }
  })

  await t.test('a row that failed before is delivered when the kitchen returns', async () => {
    const fx = await dispatchedRound(1)
    // Take it straight to "has failed a few times" instead of waiting out the
    // real backoff. The curve itself is proven in worker-decisions.test.mjs;
    // sleeping here would only prove that sleeping works.
    await pool.query(
      `update dispatches set attempts = 3, last_error = 'earlier failure',
              next_attempt_at = now() - interval '1 second' where round_id = $1`,
      [fx.roundId])

    const s = await stub(accepts)
    const db = await pool.connect()
    try {
      await drain(db, { urls: s.urls })
      const rows = await rowsFor(fx.roundId)
      for (const r of rows) {
        assert.equal(r.status, 'delivered')
        assert.ok(r.delivered_at)
        assert.equal(r.last_error, null, 'a delivered row should not keep an old error')
      }
    } finally { db.release(); await s.close() }
  })
})

// ---------------------------------------------------------------------------
test('it stops, and says so', async (t) => {
  await t.test('the attempt that crosses the ceiling is terminal', async () => {
    const fx = await dispatchedRound(1)
    await pool.query(
      `update dispatches set attempts = $2 where round_id = $1`,
      [fx.roundId, DEFAULTS.maxAttempts - 1])

    const s = await stub(refuses)
    const db = await pool.connect()
    try {
      await drain(db, { urls: s.urls })

      const rows = await rowsFor(fx.roundId)
      for (const r of rows) {
        assert.equal(r.status, 'failed')
        assert.equal(r.attempts, DEFAULTS.maxAttempts)
        assert.match(r.last_error, /503/, 'a failed row must keep the reason')
      }

      // And it is not picked up again.
      const before = mine(s.received, fx.roundId).length
      await drain(db, { urls: s.urls })
      assert.equal(mine(s.received, fx.roundId).length, before,
        'a failed row must not be retried')
    } finally { db.release(); await s.close() }
  })

  await t.test('paid food the kitchen never got flags the session for a human', async () => {
    const fx = await dispatchedRound(1)
    await pool.query(`update dispatches set attempts = $2 where round_id = $1`,
      [fx.roundId, DEFAULTS.maxAttempts - 1])

    const s = await stub(refuses)
    const db = await pool.connect()
    try {
      await drain(db, { urls: s.urls })

      const [session] = (await pool.query(
        `select s.status from sessions s join rounds r on r.session_id = s.id where r.id = $1`,
        [fx.roundId])).rows
      assert.equal(session.status, 'requires_staff_attention')

      // The round is deliberately untouched. rounds_dispatched_at_matches_status
      // ties paid_and_dispatched to dispatched_at, so moving the round would mean
      // clearing that timestamp and claiming a round was never released when it
      // was paid and released. The delivery failed, not the round.
      const [round] = (await pool.query(
        `select status, dispatched_at from rounds where id = $1`, [fx.roundId])).rows
      assert.equal(round.status, 'paid_and_dispatched')
      assert.ok(round.dispatched_at)
    } finally { db.release(); await s.close() }
  })

  await t.test('a late failure does not reopen a closed session', async () => {
    const fx = await dispatchedRound(1)
    await pool.query(`update dispatches set attempts = $2 where round_id = $1`,
      [fx.roundId, DEFAULTS.maxAttempts - 1])
    await pool.query(
      `update sessions s set status = 'closed', closed_at = now()
         from rounds r where r.session_id = s.id and r.id = $1`, [fx.roundId])

    const s = await stub(refuses)
    const db = await pool.connect()
    try {
      await drain(db, { urls: s.urls })
      const [session] = (await pool.query(
        `select s.status from sessions s join rounds r on r.session_id = s.id where r.id = $1`,
        [fx.roundId])).rows
      assert.equal(session.status, 'closed')
    } finally { db.release(); await s.close() }
  })
})

// ---------------------------------------------------------------------------
test('it survives concurrency and crashes', async (t) => {
  await t.test('two workers racing 25 queues never deliver a ticket twice', async () => {
    // ONE race is not a test. The window between claiming a row and recording
    // its outcome is where a duplicate happens, and with two rows it closes
    // often enough by luck that a broken claim still passes — which is exactly
    // what happened here: the first version of this test went green against a
    // claim with no lease at all, while two workers were really delivering two
    // rows five times. The same reason lock_round's races repeat 25 times.
    const ROUNDS = 25

    const fixtures = []
    for (let i = 0; i < ROUNDS; i++) {
      const fx = await createFixture(pool, {
        participants: 2, items: [{ price: 10_000 }], status: 'locked_for_payment',
      })
      await pool.query(
        `update rounds set status = 'paid_and_dispatched', dispatched_at = now() where id = $1`,
        [fx.roundId])
      await pool.query(
        `insert into dispatches (round_id, channel) values ($1, 'kds'), ($1, 'print')`,
        [fx.roundId])
      fixtures.push(fx)
    }
    await parkForeignRows(fixtures.map((f) => f.roundId))

    // Delivery has to take long enough for the claim-to-record window to be
    // real. An instant stub closes it before the other worker can look.
    const s = await stub(async (req, res) => {
      await new Promise((r) => setTimeout(r, 15))
      res.writeHead(200); res.end()
    })

    const ids = new Set(fixtures.map((f) => f.roundId))
    const a = await pool.connect()
    const b = await pool.connect()
    try {
      // Poll, the way the real worker's loop does, rather than assuming one
      // pass empties the queue. It does not always: the lease moves
      // `next_attempt_at`, which is both the claim's ordering column and the
      // column dispatches_due_idx is built on, so a scan running concurrently
      // with another worker's lease can pass over a row whose key just moved.
      // Measured: one worker always drains in a pass, two sometimes leave a few.
      // Nothing is lost or duplicated — those rows stay pending and the next
      // tick takes them, which is what the 2s loop in the worker is for. The
      // spec promises delivery, not single-pass drainage.
      for (let pass = 0; pass < 12; pass++) {
        await Promise.all([
          drain(a, { urls: s.urls, max: 200 }),
          drain(b, { urls: s.urls, max: 200 }),
        ])
        const left = (await pool.query(
          `select count(*)::int as n from dispatches
            where status = 'pending' and round_id = any($1::uuid[])`,
          [[...ids]])).rows[0].n
        if (left === 0) break
      }

      const ours = s.received.filter((r) => ids.has(r.round))
      const keys = ours.map((r) => `${r.round}/${r.channel}`)
      const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i)

      assert.deepEqual(duplicates, [],
        `${duplicates.length} ticket(s) delivered more than once across ${ROUNDS} races`)
      assert.equal(ours.length, ROUNDS * 2,
        `expected ${ROUNDS * 2} deliveries, saw ${ours.length}`)

      const stuck = (await pool.query(
        `select count(*)::int as n from dispatches
          where status = 'pending' and round_id = any($1::uuid[])`, [[...ids]])).rows[0].n
      assert.equal(stuck, 0, 'this test\'s rows were not drained')
    } finally { a.release(); b.release(); await s.close() }
  })

  await t.test('a worker never waits behind a row another worker holds', async () => {
    // What `skip locked` buys, which is NOT correctness — the lease provides
    // that, and removing `skip locked` leaves every other test in this file
    // green. What it buys is liveness: a worker that blocks on a held row is a
    // worker not draining the rest of the queue.
    //
    // Deterministic on purpose: A holds a real row lock in an open transaction,
    // so B either steps past it or hangs. No timing, no sleeping.
    const fx = await dispatchedRound(1)

    const a = await pool.connect()
    const b = await pool.connect()
    try {
      await a.query('begin')
      const held = (await a.query(
        `select id, channel from dispatches
          where round_id = $1 order by channel limit 1 for update`, [fx.roundId])).rows[0]

      const claimed = await Promise.race([
        claimOne(b, { leaseMs: 5_000 }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('the worker blocked behind a held row')), 3_000)),
      ])

      assert.ok(claimed, 'the worker found nothing while another row was free')
      assert.notEqual(claimed.id, held.id, 'the worker took the row another worker holds')
      assert.equal(claimed.round_id, fx.roundId)
    } finally {
      await a.query('rollback').catch(() => {})
      a.release(); b.release()
    }
  })

  await t.test('a worker that dies after delivering re-delivers, never loses', async () => {
    const fx = await dispatchedRound(1)
    const s = await stub(accepts)
    const db = await pool.connect()
    try {
      // The crash that makes this at-least-once rather than exactly-once: the
      // ticket is on the wire and the outcome was never written.
      // Die on OUR row, not on whichever row the queue happened to offer first
      // — other tests' rows are in here too and they are not ours to crash on.
      await assert.rejects(
        drain(db, {
          urls: s.urls,
          leaseMs: 300,
          hooks: {
            afterDeliver: (row) => {
              if (row.round_id === fx.roundId) throw new Error('worker died mid-flight')
            },
          },
        }),
        /worker died/
      )

      const afterCrash = await rowsFor(fx.roundId)
      assert.ok(afterCrash.every((r) => r.status === 'pending'),
        'a crash after delivery must leave the row deliverable, never delivered')

      const delivered = mine(s.received, fx.roundId).length
      assert.ok(delivered >= 1, 'the ticket really was sent before the crash')

      // Nothing had to run on time to release it: the lease expires by itself.
      await new Promise((r) => setTimeout(r, 400))

      // A second worker picks it up and sends it again. That duplicate is the
      // acceptable failure; a missing ticket for paid food is not.
      await drain(db, { urls: s.urls, leaseMs: 300 })
      const ours = mine(s.received, fx.roundId)
      assert.ok(ours.length > delivered, 'the row was not re-delivered')

      const repeats = ours.filter((r) => r.channel === ours[0].channel)
      assert.ok(repeats.length >= 2)
      assert.equal(repeats[0].round, repeats[1].round,
        'a repeat must carry the same round and channel so the receiver can collapse it')

      assert.ok((await rowsFor(fx.roundId)).every((r) => r.status === 'delivered'))
    } finally { db.release(); await s.close() }
  })

  await t.test('no lock is held while a ticket is in flight', async () => {
    // The single most important property in this change. A row lock on
    // `dispatches` is harmless, but the same mistake inside lock_round() would
    // put an HTTP call behind the only mutual-exclusion mechanism in the system
    // and turn a slow kitchen display into a payment outage.
    const fx = await dispatchedRound(1)

    let release
    const hanging = new Promise((r) => (release = r))
    const s = await stub(async (req, res) => { await hanging; res.writeHead(200); res.end() })

    const db = await pool.connect()
    const backendPid = (await db.query('select pg_backend_pid() as pid')).rows[0].pid

    const inFlight = drain(db, { urls: s.urls })
    // Give the claim time to commit and the POST time to be sent.
    await new Promise((r) => setTimeout(r, 400))

    try {
      const [backend] = (await pool.query(
        `select state from pg_stat_activity where pid = $1`, [backendPid])).rows
      assert.equal(backend.state, 'idle',
        `the worker's connection is "${backend.state}" during delivery — a transaction is open across the HTTP call`)

      // And the round is not locked: money keeps moving at that table.
      const other = await pool.connect()
      try {
        await other.query('begin')
        const locked = await other.query(
          `select id from rounds where id = $1 for update nowait`, [fx.roundId])
        assert.equal(locked.rows.length, 1, 'the worker is holding the round lock')
        await other.query('rollback')
      } finally { other.release() }
    } finally {
      release()
      await inFlight
      db.release()
      await s.close()
    }
  })
})

test.after(() => pool.end())
