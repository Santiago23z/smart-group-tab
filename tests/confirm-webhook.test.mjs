// Smart Group Tab — confirm_webhook under retries and out-of-order delivery.
//
// Two invariants live here, and both are about money that has already moved:
//
//   I2 — a paid round fires to the kitchen exactly once. Never twice (a duplicate
//        comanda), never zero (paid food nobody cooks).
//   I3 — an approved webhook is never lost. Not when it is retried, not when it
//        arrives after the reservation expired, not when the shares it paid for
//        were already retaken by someone else. Expiring never means rejecting.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  confirmWebhook,
  countWebhookEvents,
  createFixture,
  ledgerState,
  makePool,
  reserve,
  roundState,
} from './helpers.mjs'

const pool = makePool()

before(async () => {
  await pool.query('select 1')
})

after(async () => {
  await pool.end()
})

/** A round with one item, fully claimed by one reservation. */
async function claimedRound({ price = 12000, tip = 0 } = {}) {
  const f = await createFixture(pool, { participants: 2, items: [{ price, splitWays: 1 }] })
  const r = await reserve(pool, {
    roundId: f.roundId,
    participantId: f.participantIds[0],
    mode: 'remaining',
    tip,
    key: `claim-${Math.random()}`,
  })
  assert.equal(r.status, 'reserved')
  return { ...f, reservation: r }
}

describe('I2 — dispatch exactly once', () => {
  test('an approved payment settles the round and fires both channels once', async () => {
    const f = await claimedRound()

    const result = await confirmWebhook(pool, {
      eventId: 'settle-1',
      reference: f.reservation.psp_reference,
      amount: f.reservation.order_amount,
    })

    assert.equal(result.status, 'settled')

    const state = await roundState(pool, f.roundId)
    assert.equal(state.status, 'paid_and_dispatched')
    assert.equal(state.dispatched, true)
    assert.equal(state.dispatchChannels, 2, 'kds and print')
    assert.equal(state.dispatchRows, 2, 'one row per channel, no more')
    assert.equal(state.settledAmount, state.roundTotal)
  })

  test('ten concurrent retries of one event produce one contribution', async () => {
    const f = await claimedRound()

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        confirmWebhook(pool, {
          eventId: 'retry-storm',
          reference: f.reservation.psp_reference,
          amount: f.reservation.order_amount,
        })
      )
    )

    const settled = results.filter((r) => r.status === 'settled')
    const duplicates = results.filter((r) => r.status === 'duplicate_event')

    assert.equal(settled.length, 1, 'the idempotency gate must admit exactly one')
    assert.equal(duplicates.length, 9)

    const state = await roundState(pool, f.roundId)
    assert.equal(state.contributions, 1, 'a retry must never double-credit the ledger')
    assert.equal(state.dispatchRows, 2, 'nor double-fire the kitchen')
  })

  test('five diners settling concurrently fire the kitchen once, every time', async () => {
    const ROUNDS = 10
    const bad = []

    for (let round = 0; round < ROUNDS; round++) {
      const f = await createFixture(pool, {
        participants: 5,
        items: [{ price: 50000, splitWays: 5 }],
      })

      // Everyone claims their own slice first, serially — this test is about the
      // settlement race, not the claiming race.
      const reservations = []
      for (const [i, participantId] of f.participantIds.entries()) {
        const r = await reserve(pool, {
          roundId: f.roundId,
          participantId,
          mode: 'specific_shares',
          shareIds: [f.shareIds[i]],
          key: `final-${round}-${i}`,
        })
        assert.equal(r.status, 'reserved')
        reservations.push(r)
      }

      // Now all five payments confirm at once. Only the last one completes the
      // round, but all five observe a round that is about to be complete.
      const results = await Promise.all(
        reservations.map((r, i) =>
          confirmWebhook(pool, {
            eventId: `final-${round}-${i}`,
            reference: r.psp_reference,
            amount: r.order_amount,
          })
        )
      )

      const state = await roundState(pool, f.roundId)

      // Counting dispatch rows is not enough: `on conflict do nothing` on the
      // outbox swallows a second insert, so the row count stays at 2 even when
      // the transition fired repeatedly. Mutation testing proved it — removing
      // the `and status = 'pending_payment'` guard left the whole suite green.
      // This counts how many callers actually won the transition, which is the
      // thing the guard exists to make exactly one.
      const claimedDispatch = results.filter((r) => r.dispatched === true).length

      if (state.status !== 'paid_and_dispatched' || state.dispatchRows !== 2 || claimedDispatch !== 1) {
        bad.push({
          round,
          status: state.status,
          dispatchRows: state.dispatchRows,
          claimedDispatch,
        })
      }
    }

    assert.equal(bad.length, 0, `${bad.length}/${ROUNDS} rounds misfired: ${JSON.stringify(bad.slice(0, 3))}`)
  })

  test('a partly paid round does not fire', async () => {
    const f = await createFixture(pool, {
      participants: 3,
      items: [{ price: 30000, splitWays: 3 }],
    })
    const r = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[0],
      mode: 'specific_shares',
      shareIds: [f.shareIds[0]],
      key: 'only-one-pays',
    })

    await confirmWebhook(pool, {
      eventId: 'partial-1',
      reference: r.psp_reference,
      amount: r.order_amount,
    })

    const state = await roundState(pool, f.roundId)
    assert.equal(state.status, 'pending_payment')
    assert.equal(state.dispatchRows, 0, 'two thirds unpaid must not reach the kitchen')
  })

  test('a tip does not complete a round (D10)', async () => {
    const f = await createFixture(pool, {
      participants: 2,
      items: [{ price: 50000, splitWays: 2 }],
    })
    const r = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[0],
      mode: 'specific_shares',
      shareIds: [f.shareIds[0]],
      tip: 25000,
      key: 'generous',
    })

    await confirmWebhook(pool, {
      eventId: 'tip-heavy',
      reference: r.psp_reference,
      amount: r.order_amount + r.tip_amount,
    })

    const state = await roundState(pool, f.roundId)
    assert.equal(state.status, 'pending_payment', 'a large tip must not buy the food')
    assert.equal(state.dispatchRows, 0)
    assert.equal(state.settledAmount, 25000, 'only the order half counts')
  })
})

describe('I3 — no approved webhook is ever lost', () => {
  test('a declined payment releases the share immediately', async () => {
    const f = await claimedRound()

    const result = await confirmWebhook(pool, {
      eventId: 'declined-1',
      reference: f.reservation.psp_reference,
      outcome: 'declined',
      amount: f.reservation.order_amount,
    })

    assert.equal(result.status, 'released')

    const ledger = await ledgerState(pool, f.roundId)
    assert.equal(ledger.outstanding, f.roundTotal, 'the share is available again at once')

    const state = await roundState(pool, f.roundId)
    assert.equal(state.contributions, 0, 'nothing was paid, so nothing is recorded as paid')
  })

  test('an approved payment past its TTL still settles when nobody took the shares', async () => {
    const f = await claimedRound()

    await pool.query(
      `update contribution_reservations set expires_at = now() - interval '10 minutes' where id = $1`,
      [f.reservation.reservation_id]
    )

    const result = await confirmWebhook(pool, {
      eventId: 'late-but-free',
      reference: f.reservation.psp_reference,
      amount: f.reservation.order_amount,
    })

    assert.equal(result.status, 'settled', 'a slow bank must not cost the diner their order')

    const state = await roundState(pool, f.roundId)
    assert.equal(state.status, 'paid_and_dispatched')
    assert.equal(state.creditedAmount, 0, 'this is a normal settlement, not a credit')
  })

  test('an approved payment whose shares were retaken becomes session credit', async () => {
    const f = await claimedRound()

    // The diner wanders off in the payment screen; the hold lapses.
    await pool.query(
      `update contribution_reservations set expires_at = now() - interval '10 minutes' where id = $1`,
      [f.reservation.reservation_id]
    )

    // Someone else grabs the freed share and pays for it.
    const second = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[1],
      mode: 'remaining',
      key: 'took-over',
    })
    assert.equal(second.status, 'reserved')
    await confirmWebhook(pool, {
      eventId: 'takeover-settles',
      reference: second.psp_reference,
      amount: second.order_amount,
    })

    // ...and only now does the first payment land. The money really moved.
    const result = await confirmWebhook(pool, {
      eventId: 'the-late-one',
      reference: f.reservation.psp_reference,
      amount: f.reservation.order_amount,
    })

    assert.equal(result.status, 'credited', 'money that moved is never rejected')

    const state = await roundState(pool, f.roundId)
    assert.equal(state.contributions, 2, 'both payments are on the ledger')
    assert.equal(state.creditedAmount, f.roundTotal, 'the late one became credit')
    assert.equal(state.prepaidBalance, f.roundTotal, 'and the table can spend it')
    assert.equal(
      state.settledAmount,
      state.roundTotal,
      'the round itself is still paid exactly once over'
    )

    // The round stays dispatched. Reverting it would mean un-firing food that is
    // already on the grill, which is not a thing the kitchen can do. The overpayment
    // is a session-level problem, so that is where the staff flag goes — and the KDS
    // alert tray reads session status for exactly this reason.
    assert.equal(state.status, 'paid_and_dispatched', 'a dispatched round is never un-dispatched')
    assert.equal(
      state.sessionStatus,
      'needs_staff_attention',
      'but a human still has to resolve the overpayment'
    )
  })

  test('a payment for an amount we never reserved becomes credit, not a lie', async () => {
    const f = await claimedRound()

    const result = await confirmWebhook(pool, {
      eventId: 'wrong-amount',
      reference: f.reservation.psp_reference,
      amount: f.reservation.order_amount + 7000,
    })

    assert.equal(result.status, 'credited')

    const state = await roundState(pool, f.roundId)
    assert.equal(state.creditedAmount, f.reservation.order_amount + 7000)
    assert.equal(state.status, 'needs_staff_attention')
    assert.equal(state.dispatchRows, 0, 'a disagreement with the PSP must not fire the kitchen')
  })

  test('a webhook for an unknown reference is recorded rather than dropped', async () => {
    const result = await confirmWebhook(pool, {
      eventId: 'orphan',
      reference: 'sgt-does-not-exist',
      amount: 5000,
    })

    assert.equal(result.status, 'unknown_reference')

    assert.equal(
      await countWebhookEvents(pool, 'orphan'),
      1,
      'an unexplained payment must leave a trace'
    )
  })

  test('every delivery is stored, including the ones that change nothing', async () => {
    const f = await claimedRound()

    await confirmWebhook(pool, {
      eventId: 'stored-1',
      reference: f.reservation.psp_reference,
      amount: f.reservation.order_amount,
    })
    await confirmWebhook(pool, {
      eventId: 'stored-2',
      reference: f.reservation.psp_reference,
      amount: f.reservation.order_amount,
    })

    assert.equal(
      await countWebhookEvents(pool, 'stored-%'),
      2,
      'both deliveries are on record, even the redundant one'
    )
  })
})
