// Smart Group Tab — regressions found by code review.
//
// Every test here reproduces a defect that shipped green. They are grouped by the
// reason the original suite missed them, because that pattern is more useful than
// the individual bugs.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { parseTransactionEvent } from '../src/wompi/events.mjs'
import {
  addItem,
  closeRound,
  confirmWebhook,
  createVenue,
  joinSession,
  makePool,
  reserve,
  roundState,
  setItemSharing,
  voidItem,
  webhookEventsFor,
} from './helpers.mjs'

const pool = makePool()

before(async () => {
  await pool.query('select 1')
})

after(async () => {
  await pool.end()
})

async function collectingRound({ price, nicknames = ['A', 'B'] }) {
  const venue = await createVenue(pool, { products: [{ price, taxRate: 0 }] })
  const people = []
  for (const n of nicknames) {
    people.push(await joinSession(pool, { qrToken: venue.qrToken, nickname: n }))
  }
  await addItem(pool, {
    sessionId: people[0].session_id,
    participantId: people[0].participant_id,
    productId: venue.menu[0].id,
  })
  await closeRound(pool, { sessionId: people[0].session_id })
  return { venue, people, roundId: people[0].round_id }
}

// ---------------------------------------------------------------------------
// The original suite never combined three things at once: a hold that lapses, a
// free-amount claim that SPLITS that exact share, and the first payment arriving
// late. Each was tested alone; the money is lost only when all three meet.
// ---------------------------------------------------------------------------
describe('splitting a share that an unsettled hold still claims', () => {
  test('a lapsed hold that later settles cannot overcollect', async () => {
    const { people, roundId } = await collectingRound({ price: 100 })
    const [a, b] = people

    const rA = await reserve(pool, {
      roundId,
      participantId: a.participant_id,
      mode: 'remaining',
      key: 'lapsed-A',
    })
    await pool.query(
      `update contribution_reservations set expires_at = now() - interval '10 min' where id = $1`,
      [rA.reservation_id]
    )

    // B pays 40 of the 100, which splits A's share into 60 + 40.
    const rB = await reserve(pool, {
      roundId,
      participantId: b.participant_id,
      mode: 'free_amount',
      amount: 40,
      key: 'splitter-B',
    })
    assert.equal(rB.status, 'reserved')

    await confirmWebhook(pool, {
      eventId: 'split-b',
      reference: rB.psp_reference,
      amount: rB.order_amount,
    })
    await confirmWebhook(pool, {
      eventId: 'split-a',
      reference: rA.psp_reference,
      amount: rA.order_amount,
    })

    const state = await roundState(pool, roundId)
    assert.ok(
      state.settledAmount <= state.roundTotal,
      `an item worth ${state.roundTotal} collected ${state.settledAmount} against the round`
    )
    assert.equal(state.creditedAmount, 100, "A's money is real, so it becomes table credit")
    assert.equal(state.prepaidBalance, 100)
    assert.equal(state.sessionStatus, 'requires_staff_attention', 'and a human is told')
  })

  test('a lapsed hold that never settles leaves the split intact', async () => {
    const { people, roundId } = await collectingRound({ price: 100 })
    const [a, b] = people

    const rA = await reserve(pool, {
      roundId,
      participantId: a.participant_id,
      mode: 'remaining',
      key: 'abandoned-A',
    })
    await pool.query(
      `update contribution_reservations set expires_at = now() - interval '10 min' where id = $1`,
      [rA.reservation_id]
    )
    await reserve(pool, {
      roundId,
      participantId: b.participant_id,
      mode: 'free_amount',
      amount: 40,
      key: 'partial-B',
    })

    // A genuinely walked out. The other 60 must still be claimable.
    await confirmWebhook(pool, {
      eventId: 'declined-A',
      reference: rA.psp_reference,
      outcome: 'declined',
      amount: 100,
    })

    const rest = await reserve(pool, {
      roundId,
      participantId: b.participant_id,
      mode: 'remaining',
      key: 'rest-B',
    })
    assert.equal(rest.status, 'reserved')
    assert.equal(rest.order_amount, 60, 'exactly the unpaid remainder, no more')
  })
})

// ---------------------------------------------------------------------------
// Authorization was applied by hand, function by function, so the ones written
// last simply did not get it.
// ---------------------------------------------------------------------------
describe('authorization on the cart RPCs', () => {
  test('an outsider cannot re-shard an item in someone else\'s session', async () => {
    const one = await collectingRound({ price: 1000, nicknames: ['A'] })
    const other = await createVenue(pool, { products: [{ price: 500, taxRate: 0 }] })
    const outsider = await joinSession(pool, { qrToken: other.qrToken, nickname: 'Intruso' })

    const venue = await createVenue(pool, { products: [{ price: 1000, taxRate: 0 }] })
    const victim = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Victima' })
    const item = await addItem(pool, {
      sessionId: victim.session_id,
      participantId: victim.participant_id,
      productId: venue.menu[0].id,
    })

    const result = await setItemSharing(pool, {
      cartItemId: item.cart_item_id,
      participantIds: [victim.participant_id],
      participantId: outsider.participant_id,
    })

    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, 'participant_not_in_session')
    void one
  })

  test('an outsider cannot void an item in someone else\'s session', async () => {
    const other = await createVenue(pool, { products: [{ price: 500, taxRate: 0 }] })
    const outsider = await joinSession(pool, { qrToken: other.qrToken, nickname: 'Intruso' })

    const venue = await createVenue(pool, { products: [{ price: 1000, taxRate: 0 }] })
    const victim = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Victima' })
    const item = await addItem(pool, {
      sessionId: victim.session_id,
      participantId: victim.participant_id,
      productId: venue.menu[0].id,
    })

    const result = await voidItem(pool, {
      cartItemId: item.cart_item_id,
      participantId: outsider.participant_id,
    })

    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, 'participant_not_in_session')
  })

  test('a tablemate can still re-shard, which is the point of a shared tab', async () => {
    const venue = await createVenue(pool, { products: [{ price: 1000, taxRate: 0 }] })
    const a = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'A' })
    const b = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'B' })
    const item = await addItem(pool, {
      sessionId: a.session_id,
      participantId: a.participant_id,
      productId: venue.menu[0].id,
    })

    const result = await setItemSharing(pool, {
      cartItemId: item.cart_item_id,
      participantIds: [a.participant_id, b.participant_id],
      participantId: b.participant_id,
    })
    assert.equal(result.status, 'reshared')
  })
})

// ---------------------------------------------------------------------------
// I3 says an approved webhook is never lost. Two paths quietly lost one anyway.
// ---------------------------------------------------------------------------
describe('I3, the paths that leaked', () => {
  test('a second approved payment on one reference becomes credit, not silence', async () => {
    const { people, roundId } = await collectingRound({ price: 1000, nicknames: ['A'] })
    const r = await reserve(pool, {
      roundId,
      participantId: people[0].participant_id,
      mode: 'remaining',
      key: 'double-pay',
    })

    const first = await confirmWebhook(pool, {
      eventId: 'pay-once',
      reference: r.psp_reference,
      amount: r.order_amount,
    })
    assert.equal(first.status, 'settled')

    // The diner had the checkout open on two phones.
    const second = await confirmWebhook(pool, {
      eventId: 'pay-twice',
      reference: r.psp_reference,
      amount: r.order_amount,
    })

    assert.equal(second.status, 'credited', 'money that moved is never answered with silence')

    const state = await roundState(pool, roundId)
    assert.equal(state.contributions, 2)
    assert.equal(state.creditedAmount, 1000)
    assert.equal(state.prepaidBalance, 1000)
    assert.equal(state.sessionStatus, 'requires_staff_attention')
  })

  test('an unplaceable approved payment stays on the follow-up queue', async () => {
    const result = await confirmWebhook(pool, {
      eventId: 'orphan-approved',
      reference: 'sgt-nobody-has-this',
      amount: 5000,
    })
    assert.equal(result.status, 'unknown_reference')

    const rows = await webhookEventsFor(pool, 'orphan-approved')
    assert.equal(rows.length, 1)
    assert.equal(
      rows[0].processed_at,
      null,
      'stamping it processed hides it from the only index built to find it'
    )
  })

  test('an unplaceable decline is not left on the queue forever', async () => {
    const result = await confirmWebhook(pool, {
      eventId: 'orphan-declined',
      reference: 'sgt-nobody-has-this-either',
      outcome: 'declined',
      amount: 5000,
    })
    assert.equal(result.status, 'unknown_reference')

    const rows = await webhookEventsFor(pool, 'orphan-declined')
    assert.notEqual(rows[0].processed_at, null, 'nothing moved, so there is nothing to chase')
  })
})

// ---------------------------------------------------------------------------
// Input validation that stopped one field short.
// ---------------------------------------------------------------------------
describe('Wompi payload validation', () => {
  function event({ amountInCents = 1000, reference = 'sgt-x' } = {}) {
    return {
      data: {
        transaction: {
          id: 'tx',
          status: 'APPROVED',
          amount_in_cents: amountInCents,
          reference,
          currency: 'COP',
        },
      },
      signature: { properties: ['transaction.id'], checksum: 'x' },
      timestamp: 1,
    }
  }

  test('a zero-amount approval is refused at the door', () => {
    // Accepting it produced a contribution of 0, which fails a CHECK, which rolls
    // back the idempotency row, which makes Wompi retry the same failure forever.
    assert.throws(() => parseTransactionEvent(event({ amountInCents: 0 })), /positive/)
  })

  test('a missing reference is refused rather than turned into NULL', () => {
    assert.throws(() => parseTransactionEvent(event({ reference: null })), /reference/)
    assert.throws(() => parseTransactionEvent(event({ reference: '' })), /reference/)

    // And genuinely absent, not just nullish.
    const bare = event()
    delete bare.data.transaction.reference
    assert.throws(() => parseTransactionEvent(bare), /reference/)
  })
})

// ---------------------------------------------------------------------------
// A guard that existed on one entry point and not its neighbour.
// ---------------------------------------------------------------------------
describe('closing a round on a session that is done', () => {
  test('a stale client cannot fire the kitchen for a table that has left', async () => {
    const venue = await createVenue(pool, { serviceMode: 'open_tab', products: [{ price: 1000 }] })
    const diner = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'A' })
    await addItem(pool, {
      sessionId: diner.session_id,
      participantId: diner.participant_id,
      productId: venue.menu[0].id,
    })

    await pool.query(`update sessions set status = 'closed', closed_at = now() where id = $1`, [
      diner.session_id,
    ])

    const result = await closeRound(pool, { sessionId: diner.session_id })
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, 'session_closed')

    const state = await roundState(pool, diner.round_id)
    assert.equal(state.dispatchRows, 0)
  })
})
