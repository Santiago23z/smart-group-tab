// Smart Group Tab — the Wompi adapter.
//
// This is the only place where something outside our control can move the
// ledger. Until now `confirm_webhook` took `p_signature_verified` and nothing
// ever set it true, which means an unsigned POST could have fired food to the
// kitchen for free.
//
// Two things have to be right here and they are separate concerns:
//   - the signature, which decides whether we believe the message at all
//   - the units, because Wompi speaks cents and our ledger speaks pesos

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { computeChecksum, verifySignature } from '../src/wompi/signature.mjs'
import { parseTransactionEvent } from '../src/wompi/events.mjs'
import { handleWompiWebhook } from '../src/wompi/handler.mjs'
import {
  addItem,
  closeRound,
  createVenue,
  joinSession,
  makePool,
  reserve,
  roundState,
} from './helpers.mjs'

const pool = makePool()
const SECRET = 'test_events_secret'

before(async () => {
  await pool.query('select 1')
})

after(async () => {
  await pool.end()
})

/** A Wompi `transaction.updated` body, shaped the way they actually send it. */
function wompiEvent({
  id = '01-1532941443-49201',
  status = 'APPROVED',
  amountInCents = 4490000,
  reference = 'sgt-whatever',
  timestamp = 1530291395,
  secret = SECRET,
} = {}) {
  const body = {
    event: 'transaction.updated',
    data: { transaction: { id, status, amount_in_cents: amountInCents, reference, currency: 'COP' } },
    environment: 'test',
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum: null,
    },
    timestamp,
    sent_at: '2018-07-20T16:45:05.000Z',
  }
  body.signature.checksum = createHash('sha256')
    .update(`${id}${status}${amountInCents}${timestamp}${secret}`)
    .digest('hex')
    .toUpperCase()
  return body
}

describe('signature', () => {
  test('the checksum matches a known vector', () => {
    // Pinned by hand so a refactor cannot quietly change the algorithm. Wompi
    // concatenates the declared properties in order, then the timestamp, then the
    // events secret, and takes an uppercase SHA-256.
    assert.equal(
      computeChecksum(wompiEvent({ id: '01-1532941443-49201' }), SECRET),
      '396ADC4F238DC56B5F51887C2E79F5894BC02A4961C913FC3231118A17C2E0EC'
    )
  })

  test('a valid signature verifies', () => {
    assert.equal(verifySignature(wompiEvent(), SECRET), true)
  })

  test('changing the amount breaks the signature', () => {
    const body = wompiEvent()
    body.data.transaction.amount_in_cents = 100
    assert.equal(verifySignature(body, SECRET), false)
  })

  test('changing the status breaks the signature', () => {
    const body = wompiEvent({ status: 'DECLINED' })
    body.data.transaction.status = 'APPROVED'
    assert.equal(verifySignature(body, SECRET), false)
  })

  test('the wrong secret does not verify', () => {
    assert.equal(verifySignature(wompiEvent(), 'not_the_secret'), false)
  })

  test('the property order is part of the signature', () => {
    const body = wompiEvent()
    body.signature.properties = ['transaction.status', 'transaction.id', 'transaction.amount_in_cents']
    assert.equal(verifySignature(body, SECRET), false)
  })

  test('a missing checksum never verifies', () => {
    const body = wompiEvent()
    body.signature.checksum = undefined
    assert.equal(verifySignature(body, SECRET), false)
  })
})

describe('parsing', () => {
  test('cents become pesos', () => {
    const parsed = parseTransactionEvent(wompiEvent({ amountInCents: 3456000 }))
    assert.equal(parsed.amount, 34560, 'Wompi speaks cents; the ledger speaks pesos')
  })

  test('an amount that is not a whole peso is refused', () => {
    // COP has no subunit in circulation, so this means we and Wompi disagree
    // about what currency we are in. Guessing would be worse than stopping.
    assert.throws(() => parseTransactionEvent(wompiEvent({ amountInCents: 3456050 })), /whole peso/)
  })

  test('statuses map onto ledger outcomes', () => {
    assert.equal(parseTransactionEvent(wompiEvent({ status: 'APPROVED' })).outcome, 'approved')
    assert.equal(parseTransactionEvent(wompiEvent({ status: 'DECLINED' })).outcome, 'declined')
    assert.equal(parseTransactionEvent(wompiEvent({ status: 'VOIDED' })).outcome, 'declined')
    assert.equal(parseTransactionEvent(wompiEvent({ status: 'ERROR' })).outcome, 'declined')
    assert.equal(parseTransactionEvent(wompiEvent({ status: 'PENDING' })).outcome, 'pending')
  })

  test('the event id distinguishes a status change from a retry', () => {
    const pendingId = parseTransactionEvent(wompiEvent({ status: 'PENDING' })).eventId
    const approvedId = parseTransactionEvent(wompiEvent({ status: 'APPROVED' })).eventId
    const retryId = parseTransactionEvent(wompiEvent({ status: 'APPROVED' })).eventId

    assert.equal(approvedId, retryId, 'a retry of the same state is the same event')
    assert.notEqual(pendingId, approvedId, 'a transaction moving on is a new event')
  })
})

describe('the endpoint, end to end', () => {
  /** A round in collection with one diner holding the whole balance. */
  async function collecting({ price = 34560 } = {}) {
    const venue = await createVenue(pool, { products: [{ price, taxRate: 0 }] })
    const diner = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Santi' })
    await addItem(pool, {
      sessionId: diner.session_id,
      participantId: diner.participant_id,
      productId: venue.menu[0].id,
    })
    await closeRound(pool, { sessionId: diner.session_id })
    const claim = await reserve(pool, {
      roundId: diner.round_id,
      participantId: diner.participant_id,
      mode: 'remaining',
      key: `wompi-${Math.random()}`,
    })
    assert.equal(claim.status, 'reserved')
    return { diner, claim }
  }

  test('a forged payload never reaches the ledger', async () => {
    const { diner, claim } = await collecting()

    const body = wompiEvent({
      reference: claim.psp_reference,
      amountInCents: claim.order_amount * 100,
      secret: 'the_attackers_guess',
    })

    const response = await handleWompiWebhook({ body, secret: SECRET, pool })

    assert.equal(response.httpStatus, 401)
    const state = await roundState(pool, diner.round_id)
    assert.equal(state.status, 'pending_payment', 'an unsigned POST must not buy dinner')
    assert.equal(state.contributions, 0)
    assert.equal(state.dispatchRows, 0)
  })

  test('a signed approval settles the round and fires the kitchen', async () => {
    const { diner, claim } = await collecting()

    const response = await handleWompiWebhook({
      body: wompiEvent({
        id: `tx-${Math.random()}`,
        reference: claim.psp_reference,
        amountInCents: claim.order_amount * 100,
      }),
      secret: SECRET,
      pool,
    })

    assert.equal(response.httpStatus, 200)
    assert.equal(response.result.status, 'settled')

    const state = await roundState(pool, diner.round_id)
    assert.equal(state.status, 'paid_and_dispatched')
    assert.equal(state.dispatchRows, 2)
  })

  test('a signed decline releases the share', async () => {
    const { diner, claim } = await collecting()

    const response = await handleWompiWebhook({
      body: wompiEvent({
        id: `tx-${Math.random()}`,
        status: 'DECLINED',
        reference: claim.psp_reference,
        amountInCents: claim.order_amount * 100,
      }),
      secret: SECRET,
      pool,
    })

    assert.equal(response.result.status, 'released')
    const state = await roundState(pool, diner.round_id)
    assert.equal(state.status, 'pending_payment')
  })

  test('a pending transaction changes nothing', async () => {
    const { diner, claim } = await collecting()

    const response = await handleWompiWebhook({
      body: wompiEvent({
        id: `tx-${Math.random()}`,
        status: 'PENDING',
        reference: claim.psp_reference,
        amountInCents: claim.order_amount * 100,
      }),
      secret: SECRET,
      pool,
    })

    assert.equal(response.httpStatus, 200)
    assert.equal(response.result.status, 'ignored')

    const state = await roundState(pool, diner.round_id)
    assert.equal(state.contributions, 0, 'a transaction still in flight has paid nobody')
  })

  test('Wompi retrying the same event ten times credits once', async () => {
    const { diner, claim } = await collecting()

    const body = wompiEvent({
      id: `tx-${Math.random()}`,
      reference: claim.psp_reference,
      amountInCents: claim.order_amount * 100,
    })

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => handleWompiWebhook({ body, secret: SECRET, pool }))
    )

    assert.ok(responses.every((r) => r.httpStatus === 200), 'retries must be answered 200, not 500')
    assert.equal(responses.filter((r) => r.result.status === 'settled').length, 1)

    const state = await roundState(pool, diner.round_id)
    assert.equal(state.contributions, 1)
    assert.equal(state.dispatchRows, 2)
  })

  test('a transaction that goes pending then approved settles on the approval', async () => {
    const { diner, claim } = await collecting()
    const id = `tx-${Math.random()}`
    const amountInCents = claim.order_amount * 100

    await handleWompiWebhook({
      body: wompiEvent({ id, status: 'PENDING', reference: claim.psp_reference, amountInCents }),
      secret: SECRET,
      pool,
    })
    const approval = await handleWompiWebhook({
      body: wompiEvent({ id, status: 'APPROVED', reference: claim.psp_reference, amountInCents }),
      secret: SECRET,
      pool,
    })

    assert.equal(
      approval.result.status,
      'settled',
      'the earlier PENDING must not have consumed the idempotency slot'
    )
    const state = await roundState(pool, diner.round_id)
    assert.equal(state.status, 'paid_and_dispatched')
  })

  test('a malformed body is refused without touching the ledger', async () => {
    const response = await handleWompiWebhook({ body: { nonsense: true }, secret: SECRET, pool })
    assert.equal(response.httpStatus, 400)
  })

  test('a missing secret fails closed', async () => {
    await assert.rejects(
      () => handleWompiWebhook({ body: wompiEvent(), secret: '', pool }),
      /secret/i,
      'a misconfigured deployment must refuse to run, not accept everything'
    )
  })
})
