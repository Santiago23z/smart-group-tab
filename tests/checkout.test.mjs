// Smart Group Tab — creating the charge.
//
// This closes the hole the review inventory turned up: reserve_contribution
// minted a psp_reference and nothing ever asked Wompi for money against it. The
// diner reserved their share and had no way to pay it.
//
// Web Checkout rather than the transactions API, because a guest who scanned a QR
// and typed a nickname has no email, no card on file and no account (D9). Wompi's
// own screen collects whatever Nequi or PSE needs; we only have to hand over a
// correctly signed URL.
//
// Note there are TWO Wompi secrets and they are not interchangeable: the events
// secret verifies webhooks coming in, the integrity secret signs the charge going
// out. Swapping them fails in a way that looks like a key rotation problem.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { computeIntegritySignature, buildCheckoutUrl } from '../src/wompi/checkout.mjs'
import { createPaymentIntent } from '../src/wompi/intent.mjs'
import {
  addItem,
  closeRound,
  confirmWebhook,
  createVenue,
  joinSession,
  makePool,
  reserve,
  roundState,
} from './helpers.mjs'

const pool = makePool()

const CONFIG = {
  publicKey: 'pub_test_abc',
  integritySecret: 'test_integrity_secret',
  checkoutBaseUrl: 'https://checkout.wompi.co/p/',
  redirectUrl: 'https://tab.example.com/gracias',
}

before(async () => {
  await pool.query('select 1')
})

after(async () => {
  await pool.end()
})

describe('the integrity signature', () => {
  test('matches a known vector', () => {
    // Pinned by hand. Wompi concatenates reference, amount in cents, currency and
    // the integrity secret, then takes a lowercase SHA-256.
    assert.equal(
      computeIntegritySignature({
        reference: 'sgt-abc123',
        amountInCents: 3456000,
        currency: 'COP',
        integritySecret: 'test_integrity_secret',
      }),
      'cce13ed6cee66d979e4a04b4145a72ca9707ffa96c7a914b3e5ca62bb291c7f2'
    )
  })

  test('every signed field changes it', () => {
    const base = {
      reference: 'sgt-abc123',
      amountInCents: 3456000,
      currency: 'COP',
      integritySecret: 'test_integrity_secret',
    }
    const signature = computeIntegritySignature(base)

    for (const change of [
      { reference: 'sgt-other' },
      { amountInCents: 3456100 },
      { currency: 'USD' },
      { integritySecret: 'wrong' },
    ]) {
      assert.notEqual(
        computeIntegritySignature({ ...base, ...change }),
        signature,
        `changing ${Object.keys(change)[0]} must change the signature`
      )
    }
  })

  test('a missing integrity secret fails closed', () => {
    assert.throws(
      () =>
        computeIntegritySignature({
          reference: 'sgt-abc123',
          amountInCents: 1000,
          currency: 'COP',
          integritySecret: '',
        }),
      /integrity[_ ]secret/i
    )
  })
})

describe('the checkout URL', () => {
  const params = (url) => new URL(url).searchParams

  test('carries everything Wompi needs', () => {
    const url = buildCheckoutUrl({
      reference: 'sgt-abc123',
      amountInCents: 3456000,
      currency: 'COP',
      ...CONFIG,
    })
    const p = params(url)

    assert.equal(p.get('public-key'), 'pub_test_abc')
    assert.equal(p.get('currency'), 'COP')
    assert.equal(p.get('amount-in-cents'), '3456000')
    assert.equal(p.get('reference'), 'sgt-abc123')
    assert.equal(p.get('redirect-url'), 'https://tab.example.com/gracias')
    assert.equal(
      p.get('signature:integrity'),
      'cce13ed6cee66d979e4a04b4145a72ca9707ffa96c7a914b3e5ca62bb291c7f2'
    )
  })

  test('the checkout dies when the hold dies', () => {
    const expiresAt = new Date('2026-09-18T23:30:00.000Z')
    const url = buildCheckoutUrl({
      reference: 'sgt-abc123',
      amountInCents: 1000,
      currency: 'COP',
      expiresAt,
      ...CONFIG,
    })

    assert.equal(params(url).get('expiration-time'), '2026-09-18T23:30:00.000Z')
  })

  test('an expiring checkout signs its expiration too', () => {
    // Wompi's documented order once an expiration is sent:
    // <reference><amount><currency><expiration><secret>. Signing without it
    // is rejected at checkout as "La firma es inválida" — found in the first
    // live sandbox payment, which every earlier test had passed.
    const url = buildCheckoutUrl({
      reference: 'sgt-abc123',
      amountInCents: 1000,
      currency: 'COP',
      expiresAt: new Date('2026-09-18T23:30:00.000Z'),
      ...CONFIG,
    })
    const expected = createHash('sha256')
      .update(`sgt-abc1231000COP2026-09-18T23:30:00.000Z${CONFIG.integritySecret}`)
      .digest('hex')
    assert.equal(params(url).get('signature:integrity'), expected)
  })
})

describe('creating an intent from a live reservation', () => {
  async function heldShare({ price = 34560, tip = 0 } = {}) {
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
      tip,
      key: `intent-${Math.random()}`,
    })
    assert.equal(claim.status, 'reserved')
    return { diner, claim }
  }

  test('the amount charged is the order plus the tip, in cents', async () => {
    const { claim } = await heldShare({ price: 34560, tip: 5000 })

    const intent = await createPaymentIntent(pool, {
      reservationId: claim.reservation_id,
      config: CONFIG,
    })

    assert.equal(intent.status, 'created')
    // The ledger keeps the two apart (D10); Wompi charges one number.
    assert.equal(intent.amount_in_cents, (34560 + 5000) * 100)
    assert.equal(new URL(intent.checkout_url).searchParams.get('amount-in-cents'), '3956000')
  })

  test('the reference is the reservation\'s own, never a fresh one', async () => {
    const { claim } = await heldShare()

    const intent = await createPaymentIntent(pool, {
      reservationId: claim.reservation_id,
      config: CONFIG,
    })

    assert.equal(intent.reference, claim.psp_reference)
    assert.equal(
      new URL(intent.checkout_url).searchParams.get('reference'),
      claim.psp_reference,
      'minting a new reference here is how the webhook would come back unplaceable'
    )
  })

  test('the checkout expires with the hold, not later', async () => {
    const { claim } = await heldShare()

    const intent = await createPaymentIntent(pool, {
      reservationId: claim.reservation_id,
      config: CONFIG,
    })

    assert.equal(
      new URL(intent.checkout_url).searchParams.get('expiration-time'),
      new Date(claim.expires_at).toISOString(),
      'a checkout outliving its hold is how a share gets paid for twice'
    )
  })

  test('an unknown reservation is refused', async () => {
    const intent = await createPaymentIntent(pool, {
      reservationId: '00000000-0000-4000-8000-00000000dead',
      config: CONFIG,
    })
    assert.equal(intent.status, 'rejected')
    assert.equal(intent.reason, 'unknown_reservation')
  })

  test('a hold that already lapsed is refused', async () => {
    const { claim } = await heldShare()
    await pool.query(
      `update contribution_reservations set expires_at = now() - interval '1 min' where id = $1`,
      [claim.reservation_id]
    )

    const intent = await createPaymentIntent(pool, {
      reservationId: claim.reservation_id,
      config: CONFIG,
    })
    assert.equal(intent.status, 'rejected')
    assert.equal(intent.reason, 'reservation_not_payable')
  })

  test('a reservation already paid is refused', async () => {
    const { claim } = await heldShare()
    await confirmWebhook(pool, {
      eventId: `paid-${Math.random()}`,
      reference: claim.psp_reference,
      amount: claim.order_amount,
    })

    const intent = await createPaymentIntent(pool, {
      reservationId: claim.reservation_id,
      config: CONFIG,
    })
    assert.equal(intent.status, 'rejected')
    assert.equal(
      intent.reason,
      'reservation_not_payable',
      'handing out a second checkout for a settled hold is how one share gets paid twice'
    )
  })

  test('the whole circuit: reserve, charge, settle, fire', async () => {
    const { diner, claim } = await heldShare({ price: 34560 })

    const intent = await createPaymentIntent(pool, {
      reservationId: claim.reservation_id,
      config: CONFIG,
    })
    assert.equal(intent.status, 'created')

    // Wompi calls back against the reference it was handed — the link that did
    // not exist before this module.
    const settled = await confirmWebhook(pool, {
      eventId: `circuit-${Math.random()}`,
      reference: new URL(intent.checkout_url).searchParams.get('reference'),
      amount: intent.amount_in_cents / 100,
    })

    assert.equal(settled.status, 'settled')
    const state = await roundState(pool, diner.round_id)
    assert.equal(state.status, 'paid_and_dispatched')
    assert.equal(state.dispatchRows, 2)
  })
})

describe('remembering the checkout, and bringing the diner back', () => {
  async function heldShare() {
    const venue = await createVenue(pool, { products: [{ price: 20000, taxRate: 0 }] })
    const diner = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Santi' })
    await addItem(pool, { sessionId: diner.session_id, participantId: diner.participant_id, productId: venue.menu[0].id })
    await closeRound(pool, { sessionId: diner.session_id })
    const claim = await reserve(pool, {
      roundId: diner.round_id, participantId: diner.participant_id, mode: 'remaining', key: `ret-${Math.random()}`,
    })
    return { venue, claim }
  }

  const checkoutRow = async (reservationId) =>
    (await pool.query(`select * from reservation_checkouts where reservation_id = $1`, [reservationId])).rows[0]

  test('an issued checkout is recorded once; re-issuing keeps the first time', async () => {
    const { claim } = await heldShare()
    await createPaymentIntent(pool, { reservationId: claim.reservation_id, config: CONFIG })
    const first = await checkoutRow(claim.reservation_id)
    assert.ok(first, 'the periodic check only looks at reservations that reached Wompi')

    await createPaymentIntent(pool, { reservationId: claim.reservation_id, config: CONFIG })
    const again = await checkoutRow(claim.reservation_id)
    assert.equal(again.first_issued_at.getTime(), first.first_issued_at.getTime())
    assert.ok(again.last_issued_at >= first.last_issued_at)
  })

  test('a refused intent records nothing', async () => {
    const { claim } = await heldShare()
    await pool.query(`update contribution_reservations set expires_at = now() - interval '1 min' where id = $1`,
      [claim.reservation_id])
    const intent = await createPaymentIntent(pool, { reservationId: claim.reservation_id, config: CONFIG })
    assert.equal(intent.status, 'rejected')
    assert.equal(await checkoutRow(claim.reservation_id), undefined)
  })

  test('the diner comes back to their own table page', async () => {
    const { venue, claim } = await heldShare()
    const intent = await createPaymentIntent(pool, {
      reservationId: claim.reservation_id, config: CONFIG, returnOrigin: 'https://tab.example.com',
    })
    assert.equal(
      new URL(intent.checkout_url).searchParams.get('redirect-url'),
      `https://tab.example.com/t/${encodeURIComponent(venue.qrToken)}`
    )
  })

  // Wompi's firewall answers 403 to the whole checkout when redirect-url names an
  // IP address or localhost (checked 2026-09-26: 192.168.x, 8.8.8.8, localhost
  // all 403; example.com and mi-mac.local 200). Better no way back — the
  // periodic check still finds the payment — than no way to pay at all.
  for (const origin of ['http://192.168.1.132:8788', 'https://8.8.8.8', 'http://localhost:8788', 'http://[::1]:8788']) {
    test(`a return address Wompi would block (${origin}) is left out`, async () => {
      const { claim } = await heldShare()
      const intent = await createPaymentIntent(pool, {
        reservationId: claim.reservation_id, config: { ...CONFIG, redirectUrl: null }, returnOrigin: origin,
      })
      assert.equal(intent.status, 'created')
      assert.equal(new URL(intent.checkout_url).searchParams.get('redirect-url'), null)
    })
  }

  test('a named host on the local network is kept', async () => {
    const { venue, claim } = await heldShare()
    const intent = await createPaymentIntent(pool, {
      reservationId: claim.reservation_id, config: CONFIG, returnOrigin: 'http://mi-mac.local:8788',
    })
    assert.equal(
      new URL(intent.checkout_url).searchParams.get('redirect-url'),
      `http://mi-mac.local:8788/t/${encodeURIComponent(venue.qrToken)}`
    )
  })

  test('without a return origin the configured redirect is used as before', async () => {
    const { claim } = await heldShare()
    const intent = await createPaymentIntent(pool, { reservationId: claim.reservation_id, config: CONFIG })
    assert.equal(new URL(intent.checkout_url).searchParams.get('redirect-url'), CONFIG.redirectUrl)
  })
})
