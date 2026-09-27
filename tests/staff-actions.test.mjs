// Smart Group Tab — what staff can do about an alert.
//
// Every action here moves money or stops an order, and every one of them can
// meet a payment coming the other way. So beyond "does it work", each group
// asks: what does it refuse, does it leave a trace, and can it lose a race
// without corrupting the ledger?

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool, createFixture, reserve, confirmWebhook, roundState } from './helpers.mjs'
import { drain } from '../src/worker/run.mjs'

const pool = makePool(16)
test.after(() => pool.end())

const call = async (fn, ...args) => {
  const params = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await pool.query(`select ${fn}(${params}) as r`, args)).rows[0].r
}

const session = async (id) =>
  (await pool.query(`select status::text, prepaid_balance from sessions where id = $1`, [id])).rows[0]

const logFor = async (targetId) =>
  (await pool.query(`select * from staff_action_log where target_id = $1 order by created_at`, [targetId])).rows

const reservationStatus = async (id) =>
  (await pool.query(`select status::text from contribution_reservations where id = $1`, [id])).rows[0].status

/** A round paid twice: the second payment is credited to the table, which is flagged. */
async function credited({ price = 12_000 } = {}) {
  const f = await createFixture(pool, { participants: 2, items: [{ price }] })
  const r = await reserve(pool, {
    roundId: f.roundId, participantId: f.participantIds[0], mode: 'remaining', key: `sa-${Math.random()}`,
  })
  const tag = Math.random()
  const first = await confirmWebhook(pool, { eventId: `one-${tag}`, reference: r.psp_reference, amount: r.order_amount })
  const second = await confirmWebhook(pool, { eventId: `two-${tag}`, reference: r.psp_reference, amount: r.order_amount })
  assert.equal(second.status, 'credited')
  return { ...f, amount: Number(r.order_amount), appliedId: first.contribution_id, creditId: second.contribution_id }
}

/** A round in collection with one live reservation for all of it. */
async function collecting({ price = 12_000 } = {}) {
  const f = await createFixture(pool, { participants: 2, items: [{ price }] })
  const claim = await reserve(pool, {
    roundId: f.roundId, participantId: f.participantIds[0], mode: 'remaining', key: `sa-${Math.random()}`,
  })
  assert.equal(claim.status, 'reserved')
  return { ...f, claim }
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------
test('a refund of credited money is recorded pending and leaves the balance', async () => {
  const f = await credited()
  const r = await call('staff_record_refund', f.creditId, 'refunded', f.amount, 'Pagó dos veces', 'NEQUI-123')

  assert.equal(r.status, 'recorded')
  const { rows: [refund] } = await pool.query(`select * from refunds where id = $1`, [r.refund_id])
  assert.equal(refund.status, 'pending')
  assert.equal(refund.kind, 'refunded')
  assert.equal(refund.external_reference, 'NEQUI-123')
  assert.equal(refund.completed_at, null)
  assert.equal(Number((await session(f.sessionId)).prepaid_balance), 0, 'money on its way back cannot be spent')
})

test('refunds are refused when they should be', async (t) => {
  const f = await credited()
  const cases = [
    ['money that paid for food', [f.appliedId, 'refunded', 1000, 'x'], 'not_credited'],
    ['an unknown kind', [f.creditId, 'gift', 1000, 'x'], 'invalid_kind'],
    ['a zero amount', [f.creditId, 'refunded', 0, 'x'], 'invalid_amount'],
    ['an empty reason', [f.creditId, 'refunded', 1000, '   '], 'reason_required'],
    ['more than was paid', [f.creditId, 'refunded', f.amount + 1, 'x'], 'exceeds_payment'],
  ]
  for (const [name, args, reason] of cases) {
    await t.test(name, async () => {
      const r = await call('staff_record_refund', ...args)
      assert.deepEqual([r.status, r.reason], ['rejected', reason])
    })
  }
  assert.equal(Number((await session(f.sessionId)).prepaid_balance), f.amount, 'nothing moved')
  assert.equal((await pool.query(`select count(*) from refunds where contribution_id = $1`, [f.creditId])).rows[0].count, '0')
})

test('a refund larger than what is left of the credit is refused', async () => {
  const f = await credited()
  await pool.query(`update sessions set prepaid_balance = 1000 where id = $1`, [f.sessionId])
  const r = await call('staff_record_refund', f.creditId, 'refunded', 5000, 'x')
  assert.deepEqual([r.status, r.reason], ['rejected', 'exceeds_balance'])
})

test('completing a refund is final and keeps the balance; rejecting restores it', async () => {
  const f = await credited({ price: 20_000 })
  const a = await call('staff_record_refund', f.creditId, 'reversed', 5000, 'parte 1')
  const b = await call('staff_record_refund', f.creditId, 'refunded', 5000, 'parte 2')
  assert.equal(Number((await session(f.sessionId)).prepaid_balance), 10_000)

  assert.equal((await call('staff_set_refund_status', a.refund_id, 'completed')).status, 'completed')
  assert.equal(Number((await session(f.sessionId)).prepaid_balance), 10_000)
  const again = await call('staff_set_refund_status', a.refund_id, 'rejected')
  assert.equal(again.reason, 'refund_not_pending', 'completed is final')

  assert.equal((await call('staff_set_refund_status', b.refund_id, 'rejected')).status, 'rejected')
  assert.equal(Number((await session(f.sessionId)).prepaid_balance), 15_000, 'the money never left')
})

test('two staff refunding the same credit at once: only one gets through', async () => {
  for (let i = 0; i < 10; i++) {
    const f = await credited()
    const results = await Promise.all([
      call('staff_record_refund', f.creditId, 'refunded', f.amount, 'tablet A'),
      call('staff_record_refund', f.creditId, 'refunded', f.amount, 'tablet B'),
    ])
    assert.equal(results.filter((r) => r.status === 'recorded').length, 1, JSON.stringify(results))
    assert.equal(Number((await session(f.sessionId)).prepaid_balance), 0)
  }
})

// ---------------------------------------------------------------------------
// Cancelling a round
// ---------------------------------------------------------------------------
test('cancelling a round nobody paid releases its reservations and fires nothing', async () => {
  const f = await collecting()
  const r = await call('staff_cancel_round', f.roundId)

  assert.equal(r.status, 'cancelled')
  assert.equal(r.released_reservations, 1)
  assert.equal(await reservationStatus(f.claim.reservation_id), 'cancelled')
  const state = await roundState(pool, f.roundId)
  assert.equal(state.status, 'cancelled')
  assert.equal(state.dispatchRows, 0)
})

test('a round with money applied, or in the wrong state, is not cancellable', async () => {
  const partly = await createFixture(pool, { participants: 2, items: [{ price: 10_000, owner: 0 }, { price: 8_000, owner: 1 }] })
  const mine = await reserve(pool, { roundId: partly.roundId, participantId: partly.participantIds[0], mode: 'my_items', key: `sa-${Math.random()}` })
  await confirmWebhook(pool, { eventId: `part-${Math.random()}`, reference: mine.psp_reference, amount: mine.order_amount })
  assert.equal((await call('staff_cancel_round', partly.roundId)).reason, 'round_has_payments')

  for (const status of ['draft', 'paid_and_dispatched', 'cancelled']) {
    const f = await createFixture(pool, { participants: 1, items: [{ price: 5_000 }],
      status: status === 'paid_and_dispatched' ? 'locked_for_payment' : status })
    if (status === 'paid_and_dispatched') {
      await pool.query(`update rounds set status = 'paid_and_dispatched', dispatched_at = now() where id = $1`, [f.roundId])
      // Both outbox rows, as a real release leaves them: the audit checks every dispatched round has two.
      await pool.query(`insert into dispatches (round_id, channel, status, delivered_at)
                        values ($1, 'kds', 'delivered', now()), ($1, 'print', 'delivered', now())`, [f.roundId])
    }
    const r = await call('staff_cancel_round', f.roundId)
    assert.deepEqual([r.status, r.reason], ['rejected', 'round_not_cancellable'], status)
  }
})

test('a payment arriving for a cancelled round is credited, never applied', async () => {
  const f = await collecting()
  await call('staff_cancel_round', f.roundId)

  const late = await confirmWebhook(pool, {
    eventId: `after-cancel-${Math.random()}`, reference: f.claim.psp_reference, amount: f.claim.order_amount,
  })

  assert.equal(late.status, 'credited')
  assert.equal(late.reason, 'round_cancelled')
  const state = await roundState(pool, f.roundId)
  assert.equal(state.status, 'cancelled')
  assert.equal(state.dispatchRows, 0, 'nothing goes to the kitchen')
  assert.equal(state.settledAmount, 0)
  assert.equal(state.creditedAmount, Number(f.claim.order_amount))
  assert.equal(state.sessionStatus, 'requires_staff_attention')
})

test('a cancel racing the final payment: exactly one of them wins', async () => {
  for (let i = 0; i < 15; i++) {
    const f = await collecting()
    const [cancel, paid] = await Promise.all([
      call('staff_cancel_round', f.roundId),
      confirmWebhook(pool, { eventId: `race-${Math.random()}`, reference: f.claim.psp_reference, amount: f.claim.order_amount }),
    ])
    const state = await roundState(pool, f.roundId)

    if (cancel.status === 'cancelled') {
      assert.equal(paid.status, 'credited')
      assert.equal(state.status, 'cancelled')
      assert.equal(state.dispatchRows, 0)
      assert.equal(state.settledAmount, 0)
    } else {
      assert.equal(cancel.reason, 'round_not_cancellable')
      assert.equal(paid.status, 'settled')
      assert.equal(state.status, 'paid_and_dispatched')
      assert.equal(state.dispatchRows, 2)
    }
  }
})

// ---------------------------------------------------------------------------
// Resuming a round
// ---------------------------------------------------------------------------
test('a stalled round can be collected again', async () => {
  const f = await collecting()
  // The diner's payment did not match their reservation: credited, round flagged.
  const odd = await confirmWebhook(pool, { eventId: `odd-${Math.random()}`, reference: f.claim.psp_reference, amount: 1000 })
  assert.equal(odd.reason, 'amount_mismatch')
  assert.equal((await roundState(pool, f.roundId)).status, 'requires_staff_attention')

  const r = await call('staff_resume_round', f.roundId)
  assert.deepEqual([r.status, r.dispatched], ['resumed', false])
  assert.equal((await roundState(pool, f.roundId)).status, 'locked_for_payment')

  const again = await reserve(pool, { roundId: f.roundId, participantId: f.participantIds[1], mode: 'remaining', key: `sa-${Math.random()}` })
  assert.equal(again.status, 'reserved', 'the outstanding shares are collectable')
})

test('resuming a stalled round whose shares are all paid sends it to the kitchen, once', async () => {
  const f = await collecting()
  // Paid while flagged: confirm_webhook settles the shares but cannot release a flagged round.
  await pool.query(`update rounds set status = 'requires_staff_attention' where id = $1`, [f.roundId])
  const paid = await confirmWebhook(pool, { eventId: `flagged-${Math.random()}`, reference: f.claim.psp_reference, amount: f.claim.order_amount })
  assert.equal(paid.status, 'settled')
  assert.equal((await roundState(pool, f.roundId)).dispatchRows, 0)

  const r = await call('staff_resume_round', f.roundId)
  assert.equal(r.dispatched, true)
  const state = await roundState(pool, f.roundId)
  assert.equal(state.status, 'paid_and_dispatched')
  assert.equal(state.dispatchRows, 2)

  assert.equal((await call('staff_resume_round', f.roundId)).reason, 'round_not_stalled')
})

// ---------------------------------------------------------------------------
// Releasing a reservation
// ---------------------------------------------------------------------------
test('a released reservation frees its shares for someone else', async () => {
  const f = await collecting()
  const r = await call('staff_release_reservation', f.claim.reservation_id)
  assert.equal(r.status, 'released')
  assert.equal(await reservationStatus(f.claim.reservation_id), 'cancelled')

  const other = await reserve(pool, { roundId: f.roundId, participantId: f.participantIds[1], mode: 'remaining', key: `sa-${Math.random()}` })
  assert.equal(other.status, 'reserved')
})

test('only a live reservation can be released', async () => {
  const lapsed = await collecting()
  await pool.query(`update contribution_reservations set expires_at = now() - interval '1 minute' where id = $1`,
    [lapsed.claim.reservation_id])
  assert.equal((await call('staff_release_reservation', lapsed.claim.reservation_id)).reason, 'reservation_not_live')

  const paid = await collecting()
  await confirmWebhook(pool, { eventId: `rel-${Math.random()}`, reference: paid.claim.psp_reference, amount: paid.claim.order_amount })
  assert.equal((await call('staff_release_reservation', paid.claim.reservation_id)).reason, 'reservation_not_live')
})

// ---------------------------------------------------------------------------
// Retrying a delivery
// ---------------------------------------------------------------------------
async function failedDelivery() {
  const f = await createFixture(pool, { participants: 1, items: [{ price: 10_000 }] })
  await pool.query(`update rounds set status = 'paid_and_dispatched', dispatched_at = now() where id = $1`, [f.roundId])
  const { rows } = await pool.query(
    `insert into dispatches (round_id, channel, status, attempts, last_error)
     values ($1, 'kds', 'failed', 8, 'HTTP 503 kitchen down') returning id`, [f.roundId])
  await pool.query(`insert into dispatches (round_id, channel, status, delivered_at) values ($1, 'print', 'delivered', now())`, [f.roundId])
  await pool.query(`update sessions set status = 'requires_staff_attention' where id = $1`, [f.sessionId])
  return { ...f, dispatchId: rows[0].id }
}

test('a retried delivery is pending again with a fresh budget, and the worker delivers it', async () => {
  const f = await failedDelivery()
  assert.equal((await call('staff_retry_dispatch', f.dispatchId)).status, 'retrying')

  const { rows: [d] } = await pool.query(`select * from dispatches where id = $1`, [f.dispatchId])
  assert.deepEqual([d.status, d.attempts], ['pending', 0])
  assert.ok(d.next_attempt_at <= new Date())

  // The real worker loop, with a kitchen that answers. It drains whatever is
  // due in the test database; only this row is asserted on.
  const client = await pool.connect()
  try {
    await drain(client, {
      urls: { kds: 'http://kitchen.test/kds', print: 'http://kitchen.test/print' },
      token: 't',
      deliverImpl: async () => ({ ok: true }),
      max: 10_000,
    })
  } finally { client.release() }

  const { rows: [after] } = await pool.query(`select status from dispatches where id = $1`, [f.dispatchId])
  assert.equal(after.status, 'delivered')
})

test('only a failed delivery can be retried', async () => {
  const f = await failedDelivery()
  const { rows: [print] } = await pool.query(
    `select id from dispatches where round_id = $1 and channel = 'print'`, [f.roundId])
  assert.equal((await call('staff_retry_dispatch', print.id)).reason, 'dispatch_not_failed')

  await call('staff_retry_dispatch', f.dispatchId)
  assert.equal((await call('staff_retry_dispatch', f.dispatchId)).reason, 'dispatch_not_failed', 'already pending')
})

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------
test('each action is logged once when taken, and never when refused', async () => {
  const f = await collecting()
  await call('staff_cancel_round', f.roundId)
  await call('staff_cancel_round', f.roundId) // refused: already cancelled

  const log = await logFor(f.roundId)
  assert.equal(log.length, 1)
  assert.equal(log[0].action, 'cancel_round')
  assert.equal(log[0].session_id, f.sessionId)

  const c = await credited()
  const refund = await call('staff_record_refund', c.creditId, 'refunded', c.amount, 'Pagó dos veces')
  await call('staff_record_refund', c.creditId, 'refunded', 1, 'x') // refused: over the ceiling
  const [entry] = await logFor(refund.refund_id)
  assert.equal(entry.action, 'record_refund')
  assert.equal(Number(entry.detail.amount), c.amount)
  assert.equal((await pool.query(`select count(*) from staff_action_log where session_id = $1`, [c.sessionId])).rows[0].count, '1')
})

// ---------------------------------------------------------------------------
// Reconciliation keeps looking after a staff cancel
// ---------------------------------------------------------------------------
test('a reservation cancelled by staff is still checked at Wompi until its checkout dies', async () => {
  const f = await collecting()
  await pool.query(`select record_checkout_issued($1)`, [f.claim.reservation_id])
  await call('staff_cancel_round', f.roundId)

  const claimed = async () => (await pool.query(
    `select reservation_id from claim_due_checkouts(interval '0 seconds', interval '24 hours', 100000)`)).rows
    .some((r) => r.reservation_id === f.claim.reservation_id)

  assert.ok(await claimed(), 'the diner may still be paying')

  await pool.query(`update contribution_reservations set expires_at = now() - interval '11 minutes' where id = $1`,
    [f.claim.reservation_id])
  assert.ok(!(await claimed()), 'after the checkout expired, nobody can pay it')
})
