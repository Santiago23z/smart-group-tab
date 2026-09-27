// Smart Group Tab — staff alerts, derived in SQL.
//
// staff_alerts() is global by design: other files leave their own sessions in
// requires_staff_attention and their own dispatches pending. Every assertion
// here is scoped to this test's session, and the stall count is measured as a
// difference, never as an absolute.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool, createFixture, reserve, confirmWebhook } from './helpers.mjs'

const pool = makePool()
test.after(() => pool.end())

const STALL = '2 minutes'

const alerts = async () =>
  (await pool.query(`select staff_alerts($1::interval) as r`, [STALL])).rows[0].r

const alertFor = async (sessionId) =>
  (await alerts()).tables.find((t) => t.session_id === sessionId)

const flag = (sessionId) => pool.query(
  `update sessions set status = 'requires_staff_attention' where id = $1`, [sessionId])

/** A round paid twice: the second payment becomes credit and flags the session. */
async function paidTwice() {
  const f = await createFixture(pool, { participants: 2, items: [{ price: 12_000 }] })
  const r = await reserve(pool, {
    roundId: f.roundId, participantId: f.participantIds[0], mode: 'remaining', key: `a-${Math.random()}`,
  })
  const tag = Math.random()
  await confirmWebhook(pool, { eventId: `one-${tag}`, reference: r.psp_reference, amount: r.order_amount })
  const second = await confirmWebhook(pool, { eventId: `two-${tag}`, reference: r.psp_reference, amount: r.order_amount })
  assert.equal(second.status, 'credited')
  return { ...f, amount: r.order_amount }
}

/**
 * A released round whose kds dispatch has failed for good. Both channels, as a
 * real release enqueues them: `npm run audit` flags a dispatched round with any
 * other number of outbox rows.
 */
async function failedDelivery() {
  const f = await createFixture(pool, { participants: 1, items: [{ price: 10_000 }] })
  await pool.query(
    `update rounds set status = 'paid_and_dispatched', dispatched_at = now() where id = $1`, [f.roundId])
  const { rows } = await pool.query(
    `insert into dispatches (round_id, channel, status, attempts, last_error)
     values ($1, 'kds', 'failed', 8, 'HTTP 503 kitchen down') returning id`, [f.roundId])
  await pool.query(
    `insert into dispatches (round_id, channel, status, delivered_at)
     values ($1, 'print', 'delivered', now())`, [f.roundId])
  await flag(f.sessionId)
  return { ...f, dispatchId: rows[0].id }
}

// ---------------------------------------------------------------------------
test('money that could not be placed is listed with its amount', async () => {
  const f = await paidTwice()
  const a = await alertFor(f.sessionId)
  assert.ok(a, 'the table is not listed')
  const money = a.reasons.filter((r) => r.kind === 'money_not_placed')
  assert.equal(money.length, 1)
  assert.equal(Number(money[0].amount), f.amount)
  assert.ok(a.table)
})

test('a failed delivery is listed with its channel and error', async () => {
  const f = await failedDelivery()
  const [reason] = (await alertFor(f.sessionId)).reasons
  assert.equal(reason.kind, 'delivery_failed')
  assert.equal(reason.channel, 'kds')
  assert.match(reason.error, /503/)
})

test('a round stuck at requires_staff_attention with no credit is "collection stalled"', async () => {
  const f = await createFixture(pool, { participants: 1, items: [{ price: 10_000 }],
    status: 'requires_staff_attention' })
  await flag(f.sessionId)
  const [reason] = (await alertFor(f.sessionId)).reasons
  assert.equal(reason.kind, 'collection_stalled')
  assert.equal(reason.round_number, 1)
})

test('a flagged session with no derivable reason is still listed', async () => {
  const f = await createFixture(pool, { participants: 1, items: [{ price: 10_000 }] })
  await flag(f.sessionId)
  const a = await alertFor(f.sessionId)
  assert.deepEqual(a.reasons.map((r) => r.kind), ['unknown'])
})

test('a healthy session is not listed', async () => {
  const f = await createFixture(pool, { participants: 1, items: [{ price: 10_000 }] })
  assert.equal(await alertFor(f.sessionId), undefined)
})

test('no payment reference reaches the staff panel', async () => {
  const f = await paidTwice()
  const text = JSON.stringify(await alertFor(f.sessionId))
  assert.doesNotMatch(text, /psp|reference|participant/i)
})

// ---------------------------------------------------------------------------
test('the stall warning counts due rows, not rows waiting out their backoff', async () => {
  const f = await createFixture(pool, { participants: 1, items: [{ price: 10_000 }] })
  await pool.query(
    `update rounds set status = 'paid_and_dispatched', dispatched_at = now() where id = $1`, [f.roundId])

  const before = (await alerts()).stalled_dispatches.count

  // Pending, but its next attempt is in the future: scheduled, not late.
  await pool.query(
    `insert into dispatches (round_id, channel, next_attempt_at)
     values ($1, 'kds', now() + interval '1 minute')`, [f.roundId])
  assert.equal((await alerts()).stalled_dispatches.count, before)

  // Pending and due ten minutes ago: nobody is draining.
  await pool.query(
    `insert into dispatches (round_id, channel, next_attempt_at)
     values ($1, 'print', now() - interval '10 minutes')`, [f.roundId])
  const after = (await alerts()).stalled_dispatches
  assert.equal(after.count, before + 1)
  assert.ok(after.oldest_seconds >= 600)

  // Leave nothing due behind for other files' workers to trip over.
  await pool.query(`update dispatches set next_attempt_at = now() + interval '1 day' where round_id = $1`,
    [f.roundId])
})

// ---------------------------------------------------------------------------
test('acknowledging keeps the alert, and changes nothing else', async () => {
  const f = await failedDelivery()
  const ack = (await pool.query(`select acknowledge_alert($1) as r`, [f.sessionId])).rows[0].r
  assert.equal(ack.status, 'acknowledged')

  const a = await alertFor(f.sessionId)
  assert.ok(a, 'acknowledging must not hide the table')
  assert.ok(a.acknowledged_at)

  const { rows: [s] } = await pool.query(`select status from sessions where id = $1`, [f.sessionId])
  assert.equal(s.status, 'requires_staff_attention')
  const { rows: [d] } = await pool.query(`select status from dispatches where id = $1`, [f.dispatchId])
  assert.equal(d.status, 'failed')
})

test('a new incident at an acknowledged table un-acknowledges it', async () => {
  const f = await failedDelivery()
  await pool.query(`select acknowledge_alert($1)`, [f.sessionId])
  assert.ok((await alertFor(f.sessionId)).acknowledged_at)

  await pool.query(
    `update dispatches set status = 'failed', delivered_at = null, attempts = 8,
            last_error = 'printer on fire'
      where round_id = $1 and channel = 'print'`, [f.roundId])

  const a = await alertFor(f.sessionId)
  assert.equal(a.acknowledged_at, null)
  assert.equal(a.reasons.length, 2)
})

// ---------------------------------------------------------------------------
// Alerts clear themselves when staff resolve their causes.
// ---------------------------------------------------------------------------
const call = async (fn, ...args) => {
  const params = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await pool.query(`select ${fn}(${params}) as r`, args)).rows[0].r
}
const sessionStatus = async (id) =>
  (await pool.query(`select status::text from sessions where id = $1`, [id])).rows[0].status

test('a pending refund is shown on the money reason, which stays until it completes', async () => {
  const f = await paidTwice()
  const [money] = (await alertFor(f.sessionId)).reasons
  const refund = await call('staff_record_refund', money.contribution_id, 'refunded', f.amount, 'Pagó dos veces')

  const [still] = (await alertFor(f.sessionId)).reasons
  assert.equal(still.kind, 'money_not_placed', 'money on its way back is not back')
  assert.equal(still.refunds.length, 1)
  assert.equal(still.refunds[0].status, 'pending')

  await call('staff_set_refund_status', refund.refund_id, 'completed')
  assert.equal(await alertFor(f.sessionId), undefined, 'the table leaves the alerts')
  assert.equal(await sessionStatus(f.sessionId), 'open')
})

test('a partial refund does not clear the money reason', async () => {
  const f = await paidTwice()
  const [money] = (await alertFor(f.sessionId)).reasons
  const refund = await call('staff_record_refund', money.contribution_id, 'refunded', f.amount - 1000, 'parte')
  await call('staff_set_refund_status', refund.refund_id, 'completed')
  assert.equal((await alertFor(f.sessionId)).reasons[0].kind, 'money_not_placed')
  assert.equal(await sessionStatus(f.sessionId), 'requires_staff_attention')
})

test('a stalled round that also holds credit is listed as both', async () => {
  const f = await createFixture(pool, { participants: 1, items: [{ price: 10_000 }] })
  const r = await reserve(pool, { roundId: f.roundId, participantId: f.participantIds[0], mode: 'remaining', key: `b-${Math.random()}` })
  const odd = await confirmWebhook(pool, { eventId: `odd-${Math.random()}`, reference: r.psp_reference, amount: 1000 })
  assert.equal(odd.reason, 'amount_mismatch')

  const kinds = (await alertFor(f.sessionId)).reasons.map((x) => x.kind).sort()
  assert.deepEqual(kinds, ['collection_stalled', 'money_not_placed'])
})

test('solving one of two problems keeps the table listed with the other', async () => {
  // Credit from a duplicate payment, and the same round's kitchen delivery failed.
  const f = await paidTwice()
  const { rows: [d] } = await pool.query(
    `update dispatches set status = 'failed', attempts = 8, last_error = 'HTTP 503'
      where round_id = $1 and channel = 'kds' returning id`, [f.roundId])

  await call('staff_retry_dispatch', d.id)

  const a = await alertFor(f.sessionId)
  assert.deepEqual(a.reasons.map((x) => x.kind), ['money_not_placed'])
  assert.equal(await sessionStatus(f.sessionId), 'requires_staff_attention')
})

test('retrying the only failed delivery clears the table', async () => {
  const f = await failedDelivery()
  await call('staff_retry_dispatch', f.dispatchId)
  assert.equal(await alertFor(f.sessionId), undefined)
  assert.equal(await sessionStatus(f.sessionId), 'open')
})
