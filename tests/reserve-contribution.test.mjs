// Smart Group Tab — reserve_contribution under real parallel connections.
//
// This is the file the whole product rests on. With an irreversible push rail,
// every assertion here is a statement about money that cannot be clawed back:
// a share claimed twice is a diner charged for food someone else already paid for.
//
// These tests need genuine concurrency, which is why they run against a real
// Postgres and not against PGlite.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assignSharesRoundRobin,
  createFixture,
  ledgerState,
  makePool,
  raceReservations,
  reserve,
} from './helpers.mjs'

const pool = makePool()

before(async () => {
  // Fail loudly and early rather than reporting a hundred confusing failures.
  await pool.query('select 1')
})

after(async () => {
  await pool.end()
})

// A single race is not a test. Without the row lock the window between reading
// share availability and inserting the allocation is sub-millisecond, so one
// round of eight racers frequently succeeds by luck — verified by mutation
// testing, where removing FOR UPDATE still let a single-round version pass.
// Repeating the race is what makes the failure reliable.
const RACE_ROUNDS = 25

describe('I1b — mutual exclusion per share', () => {
  test('eight people claiming the same share: exactly one wins, every time', async () => {
    const outcomes = []

    for (let round = 0; round < RACE_ROUNDS; round++) {
      const f = await createFixture(pool, {
        participants: 8,
        items: [{ price: 12000, splitWays: 1 }],
      })
      const target = f.shareIds[0]

      const results = await raceReservations(
        pool,
        f.participantIds.map((participantId, i) => ({
          roundId: f.roundId,
          participantId,
          mode: 'specific_shares',
          shareIds: [target],
          key: `race-${round}-${i}`,
        }))
      )

      const state = await ledgerState(pool, f.roundId)
      outcomes.push({
        round,
        winners: results.filter((r) => r.status === 'reserved').length,
        doubleClaimed: state.doubleClaimedShares,
        reasons: [...new Set(results.filter((r) => r.status === 'rejected').map((r) => r.reason))],
      })
    }

    const bad = outcomes.filter((o) => o.winners !== 1 || o.doubleClaimed !== 0)
    assert.equal(
      bad.length,
      0,
      `${bad.length}/${RACE_ROUNDS} races overcommitted: ${JSON.stringify(bad.slice(0, 3))}`
    )

    const reasons = new Set(outcomes.flatMap((o) => o.reasons))
    assert.deepEqual([...reasons], ['shares_taken'], 'losers must be told why they lost')
  })

  test('a three-way shared item admits exactly three claimants', async () => {
    const f = await createFixture(pool, {
      participants: 6,
      items: [{ price: 32000, taxRate: 0.08, splitWays: 3 }],
    })

    // Six people, three shares, everyone grabbing at once.
    const calls = f.participantIds.map((participantId, i) => ({
      roundId: f.roundId,
      participantId,
      mode: 'specific_shares',
      shareIds: [f.shareIds[i % 3]],
      key: `shared-${i}`,
    }))

    const results = await raceReservations(pool, calls)
    const reserved = results.filter((r) => r.status === 'reserved')

    assert.equal(reserved.length, 3, 'one winner per share, no more and no fewer')

    const state = await ledgerState(pool, f.roundId)
    assert.equal(state.doubleClaimedShares, 0)
    assert.equal(state.outstanding, 0, 'all three shares are now held')
  })

  test('an expired hold releases its share to the next claimant', async () => {
    const f = await createFixture(pool, {
      participants: 2,
      items: [{ price: 12000, splitWays: 1 }],
    })
    const target = f.shareIds[0]

    const first = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[0],
      mode: 'specific_shares',
      shareIds: [target],
      key: 'expiring',
    })
    assert.equal(first.status, 'reserved')

    const blocked = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[1],
      mode: 'specific_shares',
      shareIds: [target],
      key: 'blocked',
    })
    assert.equal(blocked.status, 'rejected')

    // Walk the clock past the TTL. Expiry is lazy, so nothing has to run.
    await pool.query(
      `update contribution_reservations set expires_at = now() - interval '1 second' where id = $1`,
      [first.reservation_id]
    )

    const second = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[1],
      mode: 'specific_shares',
      shareIds: [target],
      key: 'after-expiry',
    })
    assert.equal(second.status, 'reserved', 'an abandoned checkout must free the share')
  })

  test('a confirmed reservation holds its share forever, expiry or not', async () => {
    const f = await createFixture(pool, {
      participants: 2,
      items: [{ price: 12000, splitWays: 1 }],
    })
    const target = f.shareIds[0]

    const first = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[0],
      mode: 'specific_shares',
      shareIds: [target],
      key: 'settling',
    })
    await pool.query(
      `update contribution_reservations
          set status = 'confirmed', expires_at = now() - interval '1 hour'
        where id = $1`,
      [first.reservation_id]
    )

    const after = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[1],
      mode: 'specific_shares',
      shareIds: [target],
      key: 'too-late',
    })
    assert.equal(after.status, 'rejected', 'paid money must not be overwritten by a TTL')
  })
})

describe('I1c — no overcollection', () => {
  test('eight people each covering the whole balance: only one does, every time', async () => {
    const overcollected = []

    for (let round = 0; round < RACE_ROUNDS; round++) {
      const f = await createFixture(pool, {
        participants: 8,
        items: [{ price: 12000, splitWays: 1 }],
      })

      const results = await raceReservations(
        pool,
        f.participantIds.map((participantId, i) => ({
          roundId: f.roundId,
          participantId,
          mode: 'free_amount',
          amount: f.roundTotal,
          key: `whole-${round}-${i}`,
        }))
      )

      const state = await ledgerState(pool, f.roundId)
      const winners = results.filter((r) => r.status === 'reserved').length

      if (winners !== 1 || state.claimedAmount > state.roundTotal) {
        overcollected.push({ round, winners, claimed: state.claimedAmount, total: state.roundTotal })
      }
    }

    assert.equal(
      overcollected.length,
      0,
      `${overcollected.length}/${RACE_ROUNDS} races overcollected: ${JSON.stringify(overcollected.slice(0, 3))}`
    )
  })

  test('twenty concurrent partial claims never exceed the round total', async () => {
    const f = await createFixture(pool, {
      participants: 20,
      items: [
        { price: 32000, taxRate: 0.08, splitWays: 4 },
        { price: 45000, taxRate: 0.08, splitWays: 5 },
        { price: 12000, taxRate: 0.08, splitWays: 2 },
      ],
    })

    const results = await raceReservations(
      pool,
      f.participantIds.map((participantId, i) => ({
        roundId: f.roundId,
        // Deliberately awkward amounts, so the splitter is exercised hard.
        participantId,
        mode: 'free_amount',
        amount: 1000 + i * 733,
        key: `partial-${i}`,
      }))
    )

    const state = await ledgerState(pool, f.roundId)
    assert.ok(
      state.claimedAmount <= state.roundTotal,
      `claimed ${state.claimedAmount} exceeds total ${state.roundTotal}`
    )
    assert.equal(state.doubleClaimedShares, 0)
    assert.ok(
      results.some((r) => r.status === 'reserved'),
      'at least some claims must succeed'
    )
  })

  test('claiming more than is outstanding is refused, not truncated', async () => {
    const f = await createFixture(pool, {
      participants: 1,
      items: [{ price: 10000, splitWays: 1 }],
    })

    const result = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[0],
      mode: 'free_amount',
      amount: f.roundTotal + 1,
      key: 'too-much',
    })

    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, 'amount_exceeds_outstanding')
    assert.equal(result.outstanding, f.roundTotal, 'the rejection must carry fresh state')
  })
})

describe('I1a — conservation survives concurrent splitting', () => {
  test('free-amount claims split shares without moving the sum', async () => {
    const f = await createFixture(pool, {
      participants: 12,
      items: [{ price: 45000, taxRate: 0.08, splitWays: 1 }],
    })
    const before = await ledgerState(pool, f.roundId)

    await raceReservations(
      pool,
      f.participantIds.map((participantId, i) => ({
        roundId: f.roundId,
        participantId,
        mode: 'free_amount',
        amount: 1111 + i * 97,
        key: `split-${i}`,
      }))
    )

    const after = await ledgerState(pool, f.roundId)
    assert.equal(after.shareSum, before.shareSum, 'splitting must preserve the total exactly')
    assert.equal(after.shareSum, after.roundTotal)
    assert.ok(after.shareCount > before.shareCount, 'shares should have been split')
    assert.equal(after.doubleClaimedShares, 0)
  })
})

describe('idempotency', () => {
  test('the same key replayed never claims twice', async () => {
    const f = await createFixture(pool, {
      participants: 1,
      items: [{ price: 12000, splitWays: 1 }],
    })

    const calls = Array.from({ length: 10 }, () => ({
      roundId: f.roundId,
      participantId: f.participantIds[0],
      mode: 'free_amount',
      amount: 5000,
      key: 'the-same-key',
    }))

    const results = await raceReservations(pool, calls)
    const ids = new Set(results.filter((r) => r.reservation_id).map((r) => r.reservation_id))

    assert.equal(ids.size, 1, 'ten calls with one key must yield one reservation')

    const state = await ledgerState(pool, f.roundId)
    assert.equal(state.liveReservations, 1)
    assert.equal(state.claimedAmount, 5000)
  })
})

describe('split modes', () => {
  test('my_items claims only the shares assigned to me', async () => {
    const f = await createFixture(pool, {
      participants: 3,
      items: [{ price: 30000, splitWays: 3 }],
    })
    await assignSharesRoundRobin(pool, f)

    const result = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[1],
      mode: 'my_items',
      key: 'mine',
    })

    assert.equal(result.status, 'reserved')
    assert.equal(result.order_amount, 10000, 'one third of the item, not the whole thing')
  })

  test('remaining sweeps up every free share', async () => {
    const f = await createFixture(pool, {
      participants: 4,
      items: [{ price: 30000, splitWays: 3 }],
    })
    await assignSharesRoundRobin(pool, f)

    await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[0],
      mode: 'my_items',
      key: 'first-pays-own',
    })

    const rest = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[3],
      mode: 'remaining',
      key: 'hero',
    })

    assert.equal(rest.status, 'reserved')
    assert.equal(rest.order_amount, 20000, 'the two shares nobody claimed')

    const state = await ledgerState(pool, f.roundId)
    assert.equal(state.outstanding, 0)
  })

  test('remaining on a fully claimed round is refused', async () => {
    const f = await createFixture(pool, {
      participants: 2,
      items: [{ price: 10000, splitWays: 1 }],
    })
    await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[0],
      mode: 'remaining',
      key: 'takes-all',
    })

    const second = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[1],
      mode: 'remaining',
      key: 'nothing-left',
    })

    assert.equal(second.status, 'rejected')
    assert.equal(second.reason, 'nothing_available')
  })

  test('a tip rides along without counting toward the balance', async () => {
    const f = await createFixture(pool, {
      participants: 1,
      items: [{ price: 10000, splitWays: 1 }],
    })

    const result = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[0],
      mode: 'remaining',
      tip: 2000,
      key: 'with-tip',
    })

    assert.equal(result.status, 'reserved')
    assert.equal(result.order_amount, 10000)
    assert.equal(result.tip_amount, 2000)

    const state = await ledgerState(pool, f.roundId)
    assert.equal(state.claimedAmount, 10000, 'the tip must not inflate the claimed balance')
  })
})

describe('round state', () => {
  test('a round still in draft cannot be claimed against', async () => {
    const f = await createFixture(pool, {
      participants: 1,
      items: [{ price: 10000, splitWays: 1 }],
      status: 'draft',
    })

    const result = await reserve(pool, {
      roundId: f.roundId,
      participantId: f.participantIds[0],
      mode: 'remaining',
      key: 'too-early',
    })

    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, 'round_not_collectable')
  })
})
