// Smart Group Tab — what the kitchen screen says about money: whether a
// ticket's round is paid (a word, never an amount), and what came in today.
//
// The takings are a sum over the whole database, which other tests write to,
// so every takings test measures the change its own payments make.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool, createFixture, createVenue, joinSession, addItem, closeRound, reserve, confirmWebhook } from './helpers.mjs'

const pool = makePool(8)
test.after(() => pool.end())

const call = async (fn, ...args) =>
  (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r
const state = (roundId) => call('round_payment_state', roundId)
const key = () => `kpv-${Math.random()}`

/** Wompi approves exactly what was reserved, tip included. */
const approve = (r) => confirmWebhook(pool, { eventId: key(), reference: r.psp_reference, amount: Number(r.order_amount) + Number(r.tip_amount ?? 0) })

/** An open-tab table: Ana and Beto each order one dish; the round goes to the kitchen unpaid. */
async function openTab(prices = [20_000, 10_000]) {
  const venue = await createVenue(pool, { serviceMode: 'open_tab', products: prices.map((price) => ({ price })) })
  const ana = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
  const beto = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Beto' })
  const sessionId = ana.session_id
  await addItem(pool, { sessionId, participantId: ana.participant_id, productId: venue.menu[0].id })
  await addItem(pool, { sessionId, participantId: beto.participant_id, productId: venue.menu[1].id })
  const closed = await closeRound(pool, { sessionId })
  assert.equal(closed.status, 'dispatched')
  return { sessionId, roundId: closed.round_id, ana: ana.participant_id, beto: beto.participant_id }
}

const payTab = async (t, participantId, mode = 'my_items', tip = 0) => {
  const r = await call('reserve_tab', t.sessionId, participantId, mode, key(), tip)
  assert.equal(r.status, 'reserved', JSON.stringify(r))
  return approve(r)
}

// ---------------------------------------------------------------------------
// A ticket's payment state
// ---------------------------------------------------------------------------
test('an open-tab round reaches the kitchen unpaid, and stays unpaid until every part is paid', async () => {
  const t = await openTab()
  assert.equal(await state(t.roundId), 'unpaid')

  await call('request_bill', t.sessionId, t.ana)
  await payTab(t, t.ana)
  assert.equal(await state(t.roundId), 'unpaid', 'half paid is still unpaid')

  // Beto pays in cash at the till: the same round is now paid.
  const cash = await call('staff_record_manual_payment', 'tab', t.sessionId, t.beto, 'cash', null, 0)
  assert.equal(cash.status, 'recorded', JSON.stringify(cash))
  assert.equal(await state(t.roundId), 'paid')
})

test('a round collected before the kitchen is paid when it gets there', async () => {
  const f = await createFixture(pool, { participants: 2, items: [{ price: 18_000 }] })
  assert.equal(await state(f.roundId), 'unpaid')
  await approve(await reserve(pool, { roundId: f.roundId, participantId: f.participantIds[0], mode: 'remaining', key: key() }))
  const { rows: [r] } = await pool.query(`select status::text from rounds where id = $1`, [f.roundId])
  assert.equal(r.status, 'paid_and_dispatched')
  assert.equal(await state(f.roundId), 'paid')
})

test('a hybrid round the prepaid balance paid is paid, with no contribution of its own', async () => {
  const venue = await createVenue(pool, { serviceMode: 'hybrid', products: [{ price: 30_000 }] })
  const ana = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
  const sessionId = ana.session_id
  await addItem(pool, { sessionId, participantId: ana.participant_id, productId: venue.menu[0].id })
  await closeRound(pool, { sessionId })
  await approve(await reserve(pool, { roundId: ana.round_id, participantId: ana.participant_id, mode: 'remaining', key: key() }))
  await pool.query(`update sessions set prepaid_balance = 50000 where id = $1`, [sessionId])

  await addItem(pool, { sessionId, participantId: ana.participant_id, productId: venue.menu[0].id })
  const round2 = await closeRound(pool, { sessionId })
  assert.equal(round2.status, 'dispatched')
  assert.equal(await state(round2.round_id), 'paid')
})

test('a table that left: the round is written off, not paid', async () => {
  const t = await openTab()
  await call('request_bill', t.sessionId, t.ana)
  await payTab(t, t.ana)
  assert.equal((await call('staff_write_off', t.sessionId, 'Beto se fue')).status, 'written_off')
  assert.equal(await state(t.roundId), 'written_off')
})

// ---------------------------------------------------------------------------
// Today's takings
// ---------------------------------------------------------------------------
const today = () => call('staff_takings_today')
const delta = (before, after) =>
  Object.fromEntries(['total', 'wompi', 'cash', 'card_terminal', 'tips', 'refunded'].map((k) => [k, Number(after[k]) - Number(before[k])]))

test('a day with no payments reads zero', async () => {
  const day = await call('staff_takings', '2001-01-01')
  assert.deepEqual(['total', 'wompi', 'cash', 'card_terminal', 'tips', 'refunded'].map((k) => Number(day[k])), [0, 0, 0, 0, 0, 0])
})

test('Wompi with a tip, cash and card terminal add up, each in its place', async () => {
  const before = await today()
  // Three diners, 30.000 / 20.000 / 10.000.
  const f = await createFixture(pool, { participants: 3, items: [{ price: 30_000, owner: 0 }, { price: 20_000, owner: 1 }, { price: 10_000, owner: 2 }] })
  await approve(await reserve(pool, { roundId: f.roundId, participantId: f.participantIds[0], mode: 'my_items', tip: 3_000, key: key() }))
  assert.equal((await call('staff_record_manual_payment', 'round', f.roundId, f.participantIds[1], 'cash', null, 0)).status, 'recorded')
  assert.equal((await call('staff_record_manual_payment', 'round', f.roundId, f.participantIds[2], 'card_terminal', null, 0)).status, 'recorded')

  assert.deepEqual(delta(before, await today()),
    { total: 63_000, wompi: 33_000, cash: 20_000, card_terminal: 10_000, tips: 3_000, refunded: 0 })
})

test('the day is Colombia\'s: midnight to midnight in Bogotá', async () => {
  const day = await call('staff_takings', '2026-10-12')
  assert.equal(new Date(day.from).toISOString(), '2026-10-12T05:00:00.000Z')
  assert.equal(new Date(day.to).toISOString(), '2026-10-13T05:00:00.000Z')
  // So 23:50 on the 11th in Bogotá (04:50Z on the 12th) is the day before.
  assert.ok(new Date('2026-10-12T04:50:00Z') < new Date(day.from))

  // And a payment made now counts today, not yesterday.
  const { rows: [{ d }] } = await pool.query(`select (now() at time zone 'America/Bogota')::date::text as d`)
  const yesterday = new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10)
  const [beforeToday, beforeYesterday] = [await call('staff_takings', d), await call('staff_takings', yesterday)]
  const f = await createFixture(pool, { participants: 1, items: [{ price: 7_000 }] })
  await approve(await reserve(pool, { roundId: f.roundId, participantId: f.participantIds[0], mode: 'remaining', key: key() }))
  assert.equal(delta(beforeToday, await call('staff_takings', d)).total, 7_000)
  assert.equal(delta(beforeYesterday, await call('staff_takings', yesterday)).total, 0)
})

test('money that landed as table credit was still received; a completed refund is shown apart', async () => {
  const before = await today()
  const f = await createFixture(pool, { participants: 2, items: [{ price: 12_000 }] })
  const r = await reserve(pool, { roundId: f.roundId, participantId: f.participantIds[0], mode: 'remaining', key: key() })
  await approve(r)
  const second = await approve(r)
  assert.equal(second.status, 'credited')
  assert.deepEqual(delta(before, await today()).total, 24_000)

  const refund = await call('staff_record_refund', second.contribution_id, 'refunded', 5_000, 'pagó dos veces', null)
  const pending = await today()
  assert.equal(delta(before, pending).refunded, 0, 'a pending refund has not gone back yet')
  await call('staff_set_refund_status', refund.refund_id, 'completed')
  const after = await today()
  assert.deepEqual([delta(before, after).total, delta(before, after).refunded], [24_000, 5_000])
})

test('a write-off is not money received', async () => {
  const t = await openTab([40_000, 1_000])
  await call('request_bill', t.sessionId, t.ana)
  const before = await today()
  assert.equal((await call('staff_write_off', t.sessionId, 'se fueron')).status, 'written_off')
  assert.equal(delta(before, await today()).total, 0)
})
