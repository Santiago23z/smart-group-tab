// Smart Group Tab — learning a payment's outcome without the webhook.
//
// Reconciliation is a second way for an outcome to reach the ledger, never a
// second implementation of settlement. So the question every test here asks is
// the same: does a lookup behave exactly like the webhook it stands in for, and
// can the two ever count one payment twice?

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { reconcileDue, reconcileTransaction } from '../src/wompi/reconcile.mjs'
import { handleWompiWebhook } from '../src/wompi/handler.mjs'
import { confirmWebhook, createFixture, makePool, reserve, roundState } from './helpers.mjs'

const pool = makePool(8)
after(() => pool.end())

const SECRET = 'test_events_secret'

/** A round in collection with the first diner holding all of it. */
async function reserved({ price = 12_000 } = {}) {
  const f = await createFixture(pool, { participants: 2, items: [{ price }] })
  const claim = await reserve(pool, {
    roundId: f.roundId, participantId: f.participantIds[0], mode: 'remaining', key: `rec-${Math.random()}`,
  })
  assert.equal(claim.status, 'reserved')
  return { ...f, claim }
}

/** The transaction Wompi's API returns, personal data included. */
function wompiTransaction(claim, { status = 'APPROVED', id = `rec-${Math.random()}` } = {}) {
  return {
    id,
    status,
    reference: claim.psp_reference,
    amount_in_cents: Number(claim.order_amount) * 100,
    currency: 'COP',
    payment_method_type: 'CARD',
    created_at: '2026-09-26T16:05:48.801Z',
    finalized_at: '2026-09-26T16:05:52.640Z',
    customer_email: 'diner@example.com',
    customer_data: { full_name: 'Diner', phone_number: '+573000000000' },
    billing_data: { legal_id_type: 'CC', legal_id: '1234567890' },
  }
}

/** The signed webhook Wompi would send for the same transaction. */
function webhookFor(tx) {
  const timestamp = 1_790_000_000
  const body = {
    event: 'transaction.updated',
    data: { transaction: { id: tx.id, status: tx.status, amount_in_cents: tx.amount_in_cents, reference: tx.reference, currency: 'COP' } },
    signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum: null },
    timestamp,
  }
  body.signature.checksum = createHash('sha256')
    .update(`${tx.id}${tx.status}${tx.amount_in_cents}${timestamp}${SECRET}`)
    .digest('hex')
  return body
}

const storedPayload = async (tx) =>
  (await pool.query(`select payload, signature_verified from webhook_events where event_id = $1`,
    [`${tx.id}:${tx.status}`])).rows[0]

test('an approval learned by lookup settles and dispatches the round', async () => {
  const f = await reserved()
  const result = await reconcileTransaction(pool, wompiTransaction(f.claim))

  assert.equal(result.status, 'settled')
  const state = await roundState(pool, f.roundId)
  assert.equal(state.status, 'paid_and_dispatched')
  assert.equal(state.dispatchRows, 2)
})

test('a decline learned by lookup releases the hold', async () => {
  const f = await reserved()
  const result = await reconcileTransaction(pool, wompiTransaction(f.claim, { status: 'DECLINED' }))

  assert.equal(result.status, 'released')
  const { rows } = await pool.query(`select status from contribution_reservations where id = $1`,
    [f.claim.reservation_id])
  assert.equal(rows[0].status, 'cancelled')
})

test('a transaction still pending changes nothing', async () => {
  const f = await reserved()
  const tx = wompiTransaction(f.claim, { status: 'PENDING' })
  const result = await reconcileTransaction(pool, tx)

  assert.equal(result.status, 'ignored')
  assert.equal((await roundState(pool, f.roundId)).status, 'locked_for_payment')
  assert.equal(await storedPayload(tx), undefined, 'not even an event row')
})

test('a reference that matches no reservation settles nothing', async () => {
  const tx = wompiTransaction({ psp_reference: `sgt-nobody-${Math.random()}`, order_amount: 5000 })
  const result = await reconcileTransaction(pool, tx)
  assert.equal(result.status, 'unknown_reference')
})

test('the record says it came from a lookup and keeps no personal data', async () => {
  const f = await reserved()
  const tx = wompiTransaction(f.claim)
  await reconcileTransaction(pool, tx)

  const row = await storedPayload(tx)
  assert.equal(row.payload.source, 'wompi_api')
  assert.equal(row.signature_verified, true, 'our own authenticated call to Wompi')
  assert.deepEqual(Object.keys(row.payload.data.transaction).sort(), [
    'amount_in_cents', 'created_at', 'currency', 'finalized_at', 'id', 'payment_method_type', 'reference', 'status',
  ])
  const raw = JSON.stringify(row.payload)
  assert.doesNotMatch(raw, /diner@example\.com|1234567890|\+573000000000/)
})

test('a webhook arriving after the lookup is a duplicate', async () => {
  const f = await reserved()
  const tx = wompiTransaction(f.claim)
  await reconcileTransaction(pool, tx)

  const late = await handleWompiWebhook({ body: webhookFor(tx), secret: SECRET, pool })
  assert.equal(late.httpStatus, 200)
  assert.equal(late.result.status, 'duplicate_event')

  const state = await roundState(pool, f.roundId)
  assert.equal(state.contributions, 1)
  assert.equal(state.dispatchRows, 2)
})

test('a lookup after the webhook is a duplicate', async () => {
  const f = await reserved()
  const tx = wompiTransaction(f.claim)
  const first = await handleWompiWebhook({ body: webhookFor(tx), secret: SECRET, pool })
  assert.equal(first.result.status, 'settled')

  const result = await reconcileTransaction(pool, tx)
  assert.equal(result.status, 'duplicate_event')
  assert.equal((await roundState(pool, f.roundId)).contributions, 1)
})

test('late money found by a lookup is credited and flagged, as for a late webhook', async () => {
  const f = await reserved()
  await pool.query(
    `update contribution_reservations set expires_at = now() - interval '10 minutes' where id = $1`,
    [f.claim.reservation_id]
  )
  const second = await reserve(pool, {
    roundId: f.roundId, participantId: f.participantIds[1], mode: 'remaining', key: `rec-take-${Math.random()}`,
  })
  assert.equal(second.status, 'reserved')
  await confirmWebhook(pool, {
    eventId: `rec-take-${Math.random()}`, reference: second.psp_reference, amount: second.order_amount,
  })

  const result = await reconcileTransaction(pool, wompiTransaction(f.claim))

  assert.equal(result.status, 'credited')
  const state = await roundState(pool, f.roundId)
  assert.equal(state.creditedAmount, Number(f.claim.order_amount))
  assert.equal(state.prepaidBalance, Number(f.claim.order_amount))
  assert.equal(state.sessionStatus, 'requires_staff_attention')
})

// ---------------------------------------------------------------------------
// The periodic check. Wompi is a plain object here: what is under test is which
// reservations get asked about and what happens with the answer.
// ---------------------------------------------------------------------------

/** A fake Wompi that knows some references, and records what it was asked. */
function fakeWompi(byReference = {}) {
  const asked = []
  return {
    asked,
    findByReference: async (reference) => {
      asked.push(reference)
      const answer = byReference[reference]
      if (answer instanceof Error) throw answer
      return answer ?? []
    },
  }
}

const issued = (reservationId) => pool.query(`select record_checkout_issued($1)`, [reservationId])
const checkout = async (reservationId) =>
  (await pool.query(`select * from reservation_checkouts where reservation_id = $1`, [reservationId])).rows[0]

// A large limit so rows left due by earlier runs can never crowd this run's out.
const sweep = (api) => reconcileDue(pool, { api, intervalSeconds: 3600, limit: 100_000 })

test('an approval nobody told us about is found and settled', async () => {
  const f = await reserved()
  await issued(f.claim.reservation_id)
  const api = fakeWompi({ [f.claim.psp_reference]: [wompiTransaction(f.claim)] })

  await sweep(api)

  assert.ok(api.asked.includes(f.claim.psp_reference))
  assert.equal((await roundState(pool, f.roundId)).status, 'paid_and_dispatched')
  const row = await checkout(f.claim.reservation_id)
  assert.equal(row.check_count, 1)
  assert.equal(row.last_outcome, 'APPROVED')
})

test('a reservation nobody took to Wompi is never asked about', async () => {
  const f = await reserved()
  const api = fakeWompi()
  await sweep(api)
  assert.ok(!api.asked.includes(f.claim.psp_reference))
})

test('a settled reservation is no longer asked about', async () => {
  const f = await reserved()
  await issued(f.claim.reservation_id)
  await reconcileTransaction(pool, wompiTransaction(f.claim))

  const api = fakeWompi()
  await sweep(api)
  assert.ok(!api.asked.includes(f.claim.psp_reference))
})

test('a released reservation is no longer asked about', async () => {
  const f = await reserved()
  await issued(f.claim.reservation_id)
  await reconcileTransaction(pool, wompiTransaction(f.claim, { status: 'DECLINED' }))

  const api = fakeWompi()
  await sweep(api)
  assert.ok(!api.asked.includes(f.claim.psp_reference))
})

test('a checkout issued more than 24 hours ago is given up on', async () => {
  const f = await reserved()
  await issued(f.claim.reservation_id)
  await pool.query(
    `update reservation_checkouts set first_issued_at = now() - interval '25 hours' where reservation_id = $1`,
    [f.claim.reservation_id]
  )
  const api = fakeWompi()
  await sweep(api)
  assert.ok(!api.asked.includes(f.claim.psp_reference))
})

test('a lapsed hold is still checked: late money is what this is for', async () => {
  const f = await reserved()
  await issued(f.claim.reservation_id)
  await pool.query(`update contribution_reservations set expires_at = now() - interval '10 minutes' where id = $1`,
    [f.claim.reservation_id])
  const api = fakeWompi({ [f.claim.psp_reference]: [wompiTransaction(f.claim)] })

  await sweep(api)

  assert.ok(api.asked.includes(f.claim.psp_reference))
  assert.equal((await roundState(pool, f.roundId)).contributions, 1)
})

test('Wompi failing changes nothing and the reservation is checked next interval', async () => {
  const f = await reserved()
  await issued(f.claim.reservation_id)
  const api = fakeWompi({ [f.claim.psp_reference]: new Error('Wompi answered 503') })

  await sweep(api)

  assert.equal((await roundState(pool, f.roundId)).status, 'locked_for_payment')
  const row = await checkout(f.claim.reservation_id)
  assert.match(row.last_outcome, /^error: Wompi answered 503/)
  const wait = (row.next_check_at - Date.now()) / 1000
  assert.ok(wait > 3500 && wait <= 3600, `due again after one interval, not ${wait}s`)
})

test('nothing at Wompi yet: checked again next interval', async () => {
  const f = await reserved()
  await issued(f.claim.reservation_id)
  await sweep(fakeWompi())

  const row = await checkout(f.claim.reservation_id)
  assert.equal(row.last_outcome, 'none')

  const again = fakeWompi()
  await sweep(again)
  assert.ok(!again.asked.includes(f.claim.psp_reference), 'not before the interval is up')
})

test('a decline and a later approval on one reference settle, whatever order Wompi lists them in', async () => {
  const f = await reserved()
  await issued(f.claim.reservation_id)
  const api = fakeWompi({
    [f.claim.psp_reference]: [
      wompiTransaction(f.claim, { status: 'DECLINED' }),
      wompiTransaction(f.claim, { status: 'APPROVED' }),
    ],
  })

  await sweep(api)

  const state = await roundState(pool, f.roundId)
  assert.equal(state.status, 'paid_and_dispatched')
  assert.equal(state.creditedAmount, 0, 'settled as ordered, not as late credit')
})
