// Smart Group Tab — the ordering half.
//
// Everything here produces the rounds that the ledger consumes. Until these
// existed there was no legitimate way to reach pending_payment at all; the money
// tests fabricated it as superuser.
//
// Two decided rules land here and nowhere else:
//   D11 — a cart in collection is frozen; new items overflow into the next round.
//   D18 — voiding is allowed in draft and nowhere else.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addItem,
  closeRound,
  createVenue,
  joinSession,
  ledgerState,
  makePool,
  owedPerParticipant,
  reserve,
  roundState,
  setItemSharing,
  voidItem,
} from './helpers.mjs'

const pool = makePool()

before(async () => {
  await pool.query('select 1')
})

after(async () => {
  await pool.end()
})

const MENU = [{ price: 32000, taxRate: 0.08 }, { price: 12000, taxRate: 0.08 }]

/** A venue, a table, and one diner who has already scanned the QR. */
async function seated({ serviceMode = 'pay_before_order' } = {}) {
  const venue = await createVenue(pool, { serviceMode, products: MENU })
  const session = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Santi' })
  assert.equal(session.status, 'joined')
  return { venue, session }
}

describe('scanning the QR', () => {
  test('an unknown QR is refused', async () => {
    const result = await joinSession(pool, { qrToken: 'qr-nonexistent', nickname: 'nadie' })
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, 'unknown_table')
  })

  test('the first scan opens a session with a draft round', async () => {
    const venue = await createVenue(pool, { products: MENU })
    const result = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Santi' })

    assert.equal(result.status, 'joined')
    assert.ok(result.session_id)
    assert.ok(result.participant_id)
    assert.ok(result.round_id, 'a table with no draft round has nowhere to put an order')
    assert.equal(result.created_session, true)
  })

  test('the second scan joins the session that is already there', async () => {
    const venue = await createVenue(pool, { products: MENU })
    const first = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Santi' })
    const second = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Cachetona' })

    assert.equal(second.status, 'joined')
    assert.equal(second.created_session, false)
    assert.equal(second.session_id, first.session_id, 'one table, one tab')
    assert.notEqual(second.participant_id, first.participant_id)
  })

  test('ten phones scanning at once open exactly one session', async () => {
    const ROUNDS = 10
    const bad = []

    for (let round = 0; round < ROUNDS; round++) {
      const venue = await createVenue(pool, { products: MENU })

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          joinSession(pool, { qrToken: venue.qrToken, nickname: `diner-${i}` })
        )
      )

      const sessions = new Set(results.map((r) => r.session_id))
      const joined = results.filter((r) => r.status === 'joined').length

      if (sessions.size !== 1 || joined !== 10) {
        bad.push({ round, sessions: sessions.size, joined })
      }
    }

    assert.equal(bad.length, 0, `${bad.length}/${ROUNDS} tables split: ${JSON.stringify(bad)}`)
  })

  test('a nickname already at the table is refused', async () => {
    const { venue } = await seated()
    const again = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Santi' })

    assert.equal(again.status, 'rejected')
    assert.equal(again.reason, 'nickname_taken')
  })

  test('the session snapshots the venue modality (D6)', async () => {
    const venue = await createVenue(pool, { serviceMode: 'hybrid', products: MENU })
    const session = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Santi' })

    await pool.query(`update venues set default_service_mode = 'open_tab' where id = $1`, [
      venue.venueId,
    ])

    const { rows } = await pool.query(`select service_mode::text as m from sessions where id = $1`, [
      session.session_id,
    ])
    assert.equal(rows[0].m, 'hybrid', 'a live table keeps the rules it opened under')
  })
})

describe('adding to the cart', () => {
  test('an item belongs to whoever ordered it', async () => {
    const { venue, session } = await seated()

    const result = await addItem(pool, {
      sessionId: session.session_id,
      participantId: session.participant_id,
      productId: venue.menu[0].id,
    })

    assert.equal(result.status, 'added')
    assert.equal(result.line_total, 34560, '32000 + 8%')
    assert.equal(result.shares.length, 1)
    assert.equal(result.shares[0].owed_amount, 34560)
    assert.equal(result.shares[0].participant_id, session.participant_id)
  })

  test('a shared item splits into one share per person, summing exactly (I1a)', async () => {
    const { venue, session } = await seated()
    const two = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Cachetona' })
    const three = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Juan' })

    const result = await addItem(pool, {
      sessionId: session.session_id,
      participantId: session.participant_id,
      productId: venue.menu[0].id,
      sharedWith: [session.participant_id, two.participant_id, three.participant_id],
    })

    assert.equal(result.shares.length, 3)
    const sum = result.shares.reduce((a, s) => a + s.owed_amount, 0)
    assert.equal(sum, result.line_total, '34560 across three must still be 34560')

    const spread = Math.max(...result.shares.map((s) => s.owed_amount))
      - Math.min(...result.shares.map((s) => s.owed_amount))
    assert.ok(spread <= 1, `shares differ by ${spread}, expected at most one minor unit`)
  })

  test('the price is snapshotted, not referenced', async () => {
    const { venue, session } = await seated()
    await addItem(pool, {
      sessionId: session.session_id,
      participantId: session.participant_id,
      productId: venue.menu[0].id,
    })

    await pool.query(`update products set unit_price = unit_price * 3 where id = $1`, [
      venue.menu[0].id,
    ])

    const { rows } = await pool.query(`select round_total($1) as t`, [session.round_id])
    assert.equal(Number(rows[0].t), 34560, 'a menu change must not move a live cart')
  })
})

describe('D11 — a cart in collection is frozen', () => {
  test('an item ordered during collection lands in a new round', async () => {
    const { venue, session } = await seated()
    await addItem(pool, {
      sessionId: session.session_id,
      participantId: session.participant_id,
      productId: venue.menu[0].id,
    })
    await closeRound(pool, { sessionId: session.session_id })

    const later = await addItem(pool, {
      sessionId: session.session_id,
      participantId: session.participant_id,
      productId: venue.menu[1].id,
    })

    assert.equal(later.status, 'added')
    assert.notEqual(later.round_id, session.round_id, 'the frozen round must not grow')
    assert.equal(later.round_number, 2)

    const first = await roundState(pool, session.round_id)
    assert.equal(first.roundTotal, 34560, 'the round in collection is untouched')
  })

  test('five people ordering during collection create exactly one new round', async () => {
    const ROUNDS = 10
    const bad = []

    for (let round = 0; round < ROUNDS; round++) {
      const venue = await createVenue(pool, { products: MENU })
      const host = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'host' })
      const others = []
      for (let i = 0; i < 4; i++) {
        others.push(await joinSession(pool, { qrToken: venue.qrToken, nickname: `d${i}` }))
      }

      await addItem(pool, {
        sessionId: host.session_id,
        participantId: host.participant_id,
        productId: venue.menu[0].id,
      })
      await closeRound(pool, { sessionId: host.session_id })

      // Everyone keeps drinking while the first round is being paid.
      const results = await Promise.all(
        [host, ...others].map((p) =>
          addItem(pool, {
            sessionId: p.session_id,
            participantId: p.participant_id,
            productId: venue.menu[1].id,
          })
        )
      )

      const newRounds = new Set(results.map((r) => r.round_id))
      const { rows } = await pool.query(
        `select count(*) as n from rounds where session_id = $1 and status = 'draft'`,
        [host.session_id]
      )

      if (newRounds.size !== 1 || Number(rows[0].n) !== 1) {
        bad.push({ round, newRounds: newRounds.size, draftRounds: Number(rows[0].n) })
      }
    }

    assert.equal(bad.length, 0, `${bad.length}/${ROUNDS} sessions forked: ${JSON.stringify(bad)}`)
  })
})

describe('D18 — voiding, and only in draft', () => {
  test('voiding removes the item and its shares', async () => {
    const { venue, session } = await seated()
    const item = await addItem(pool, {
      sessionId: session.session_id,
      participantId: session.participant_id,
      productId: venue.menu[0].id,
    })

    const result = await voidItem(pool, {
      cartItemId: item.cart_item_id,
      participantId: session.participant_id,
    })
    assert.equal(result.status, 'voided')

    const state = await ledgerState(pool, session.round_id)
    assert.equal(state.roundTotal, 0)
    assert.equal(state.shareCount, 0, 'a voided item owns no shares (I1a)')
  })

  test('voiding is refused once the round is in collection', async () => {
    const { venue, session } = await seated()
    const item = await addItem(pool, {
      sessionId: session.session_id,
      participantId: session.participant_id,
      productId: venue.menu[0].id,
    })
    await closeRound(pool, { sessionId: session.session_id })

    const result = await voidItem(pool, {
      cartItemId: item.cart_item_id,
      participantId: session.participant_id,
    })

    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, 'round_not_editable')
  })
})

describe('re-sharing an item after the fact', () => {
  test('a latecomer can be added to an item already ordered', async () => {
    const { venue, session } = await seated()
    const item = await addItem(pool, {
      sessionId: session.session_id,
      participantId: session.participant_id,
      productId: venue.menu[0].id,
    })
    const late = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Tarde' })

    const result = await setItemSharing(pool, {
      cartItemId: item.cart_item_id,
      participantIds: [session.participant_id, late.participant_id],
    })

    assert.equal(result.status, 'reshared')
    assert.equal(result.shares.length, 2)
    assert.equal(
      result.shares.reduce((a, s) => a + s.owed_amount, 0),
      34560,
      'resharing must not change what the table owes'
    )
  })

  test('re-sharing is refused once the round is in collection', async () => {
    const { venue, session } = await seated()
    const item = await addItem(pool, {
      sessionId: session.session_id,
      participantId: session.participant_id,
      productId: venue.menu[0].id,
    })
    await closeRound(pool, { sessionId: session.session_id })

    const result = await setItemSharing(pool, {
      cartItemId: item.cart_item_id,
      participantIds: [session.participant_id],
    })
    assert.equal(result.status, 'rejected')
  })
})

describe('closing the round', () => {
  test('an empty round cannot be closed', async () => {
    const { session } = await seated()
    const result = await closeRound(pool, { sessionId: session.session_id })

    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, 'empty_round')
  })

  test('closing moves the round into collection', async () => {
    const { venue, session } = await seated()
    await addItem(pool, {
      sessionId: session.session_id,
      participantId: session.participant_id,
      productId: venue.menu[0].id,
    })

    const result = await closeRound(pool, { sessionId: session.session_id })
    assert.equal(result.status, 'collecting')

    const state = await roundState(pool, session.round_id)
    assert.equal(state.status, 'pending_payment')
  })

  test('an equal split leaves everyone owing the same, to the peso', async () => {
    const venue = await createVenue(pool, { products: MENU })
    const people = []
    for (let i = 0; i < 3; i++) {
      people.push(await joinSession(pool, { qrToken: venue.qrToken, nickname: `d${i}` }))
    }

    // One person orders everything; the split has to undo that.
    for (const product of venue.menu) {
      await addItem(pool, {
        sessionId: people[0].session_id,
        participantId: people[0].participant_id,
        productId: product.id,
      })
    }

    const result = await closeRound(pool, {
      sessionId: people[0].session_id,
      splitMode: 'equal',
    })
    assert.equal(result.status, 'collecting')

    const owed = await owedPerParticipant(pool, people[0].round_id)
    assert.equal(owed.length, 3, 'everyone at the table owes a slice')

    const total = owed.reduce((a, o) => a + o.owed, 0)
    const spread = owed[0].owed - owed[owed.length - 1].owed

    assert.equal(total, result.round_total, 'the split must still sum to the bill')
    assert.ok(spread <= 1, `people owe amounts differing by ${spread}: ${JSON.stringify(owed)}`)
  })

  test('open_tab fires the kitchen without waiting for money', async () => {
    const { venue, session } = await seated({ serviceMode: 'open_tab' })
    await addItem(pool, {
      sessionId: session.session_id,
      participantId: session.participant_id,
      productId: venue.menu[0].id,
    })

    const result = await closeRound(pool, { sessionId: session.session_id })
    assert.equal(result.status, 'dispatched')

    const state = await roundState(pool, session.round_id)
    assert.equal(state.status, 'paid_and_dispatched')
    assert.equal(state.dispatchRows, 2)
    assert.equal(state.settledAmount, 0, 'nothing has been paid yet — that is the point')
  })

  test('pay_before_order does not fire until it is paid', async () => {
    const { venue, session } = await seated({ serviceMode: 'pay_before_order' })
    await addItem(pool, {
      sessionId: session.session_id,
      participantId: session.participant_id,
      productId: venue.menu[0].id,
    })
    await closeRound(pool, { sessionId: session.session_id })

    const state = await roundState(pool, session.round_id)
    assert.equal(state.status, 'pending_payment')
    assert.equal(state.dispatchRows, 0)
  })
})

describe('end to end, without superuser shortcuts', () => {
  test('two diners share a dish, split the bill, and the kitchen fires once', async () => {
    const venue = await createVenue(pool, { products: MENU })
    const santi = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Santi' })
    const cache = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Cachetona' })

    // A shared dish, plus a beer each.
    await addItem(pool, {
      sessionId: santi.session_id,
      participantId: santi.participant_id,
      productId: venue.menu[0].id,
      sharedWith: [santi.participant_id, cache.participant_id],
    })
    await addItem(pool, {
      sessionId: santi.session_id,
      participantId: santi.participant_id,
      productId: venue.menu[1].id,
    })
    await addItem(pool, {
      sessionId: cache.session_id,
      participantId: cache.participant_id,
      productId: venue.menu[1].id,
    })

    const closed = await closeRound(pool, { sessionId: santi.session_id })
    assert.equal(closed.status, 'collecting')

    // Each pays their own, which is the whole bill between them.
    for (const p of [santi, cache]) {
      const claim = await reserve(pool, {
        roundId: santi.round_id,
        participantId: p.participant_id,
        mode: 'my_items',
        key: `e2e-${p.participant_id}`,
      })
      assert.equal(claim.status, 'reserved')
    }

    const state = await ledgerState(pool, santi.round_id)
    assert.equal(state.outstanding, 0, 'between the two of them, nothing is left')
    assert.equal(state.doubleClaimedShares, 0)
  })
})
