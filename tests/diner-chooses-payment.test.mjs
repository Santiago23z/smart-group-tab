// Smart Group Tab — the diner chooses how the table pays: each round, or a tab
// paid at the end. Later diners follow the table; a table paying each round can
// switch to a tab, and what it already paid is never on the tab.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool, createVenue, addItem, closeRound, reserve, confirmWebhook } from './helpers.mjs'

const pool = makePool(8)
test.after(() => pool.end())

const call = async (fn, ...args) =>
  (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r
const join = (qr, nickname, mode = null) => call('open_or_join_session', qr, nickname, mode)
const key = () => `dcp-${Math.random()}`
const modeOf = async (sessionId) =>
  (await pool.query(`select service_mode::text as m from sessions where id = $1`, [sessionId])).rows[0].m
const sessionsAt = async (tableId) =>
  Number((await pool.query(`select count(*) from sessions where table_id = $1`, [tableId])).rows[0].count)

/** Pay a round in collection whole, through the same path Wompi takes. */
async function payRound(roundId, participantId) {
  const r = await reserve(pool, { roundId, participantId, mode: 'remaining', key: key() })
  assert.equal(r.status, 'reserved', JSON.stringify(r))
  return confirmWebhook(pool, { eventId: key(), reference: r.psp_reference, amount: r.order_amount })
}

// ---------------------------------------------------------------------------
// Choosing at the door
// ---------------------------------------------------------------------------
test('the first diner opens a tab at a venue set to pay first: the round goes to the kitchen unpaid', async () => {
  const venue = await createVenue(pool, { products: [{ price: 20_000 }] })
  const ana = await join(venue.qrToken, 'Ana', 'open_tab')
  assert.deepEqual([ana.status, ana.service_mode, ana.chose], ['joined', 'open_tab', true])
  await addItem(pool, { sessionId: ana.session_id, participantId: ana.participant_id, productId: venue.menu[0].id })
  assert.equal((await closeRound(pool, { sessionId: ana.session_id })).status, 'dispatched')
})

test('no choice: the venue\'s mode, as before', async () => {
  const venue = await createVenue(pool, { serviceMode: 'open_tab' })
  const ana = await join(venue.qrToken, 'Ana')
  assert.deepEqual([ana.service_mode, ana.chose], ['open_tab', false])
})

test('hybrid or anything else is refused, and opens nothing', async () => {
  const venue = await createVenue(pool)
  for (const mode of ['hybrid', 'fiado', '']) {
    const r = await join(venue.qrToken, 'Ana', mode)
    assert.deepEqual([r.status, r.reason], ['rejected', 'invalid_mode'], mode)
  }
  assert.equal(await sessionsAt(venue.tableId), 0)
})

test('a later diner follows the table, whatever they chose', async () => {
  const venue = await createVenue(pool)
  const ana = await join(venue.qrToken, 'Ana', 'pay_before_order')
  const beto = await join(venue.qrToken, 'Beto', 'open_tab')
  assert.equal(beto.session_id, ana.session_id)
  assert.deepEqual([beto.service_mode, beto.chose], ['pay_before_order', false])
  assert.equal(await modeOf(ana.session_id), 'pay_before_order')
})

test('the table status says free or open and how it pays, and nothing private', async () => {
  const venue = await createVenue(pool)
  assert.deepEqual(await call('table_status', venue.qrToken), { status: 'free', venue: 'fixture', service_mode: null })

  const ana = await join(venue.qrToken, 'Ana', 'open_tab')
  const open = await call('table_status', venue.qrToken)
  assert.deepEqual(open, { status: 'open', venue: 'fixture', service_mode: 'open_tab' })
  assert.doesNotMatch(JSON.stringify(open), new RegExp(`Ana|${ana.session_id}|amount|total`))

  assert.deepEqual(await call('table_status', 'qr-no-such-table'), { status: 'unknown' })
})

// ---------------------------------------------------------------------------
// Switching to a tab
// ---------------------------------------------------------------------------
/** Ana alone, paying each round, with round 1 paid and in the kitchen. */
async function paidFirstRound() {
  const venue = await createVenue(pool, { products: [{ price: 30_000 }, { price: 12_000 }] })
  const ana = await join(venue.qrToken, 'Ana', 'pay_before_order')
  const s = ana.session_id
  await addItem(pool, { sessionId: s, participantId: ana.participant_id, productId: venue.menu[0].id })
  const r1 = await closeRound(pool, { sessionId: s })
  assert.equal(r1.status, 'collecting')
  await payRound(r1.round_id, ana.participant_id)
  return { venue, s, ana: ana.participant_id, r1: r1.round_id }
}

test('Ana stops paying each round: round 2 goes unpaid, and the tab holds round 2 only', async () => {
  const t = await paidFirstRound()
  const r = await call('switch_to_tab', t.s, t.ana)
  assert.deepEqual([r.status, r.service_mode], ['switched', 'open_tab'])
  assert.equal(await modeOf(t.s), 'open_tab')

  await addItem(pool, { sessionId: t.s, participantId: t.ana, productId: t.venue.menu[1].id })
  assert.equal((await closeRound(pool, { sessionId: t.s })).status, 'dispatched')

  assert.equal((await call('request_bill', t.s, t.ana)).status, 'requested')
  const tab = await call('tab_summary', t.s)
  assert.equal(Number(tab.total), 12_000, 'round 1 was paid before the kitchen and is not on the tab')
})

test('a dish already in the draft round follows the switch', async () => {
  const t = await paidFirstRound()
  await addItem(pool, { sessionId: t.s, participantId: t.ana, productId: t.venue.menu[1].id })
  await call('switch_to_tab', t.s, t.ana)
  assert.equal((await closeRound(pool, { sessionId: t.s })).status, 'dispatched')
})

test('the switch is refused while a round is in collection, after the bill, on a tab, when closed, and for a stranger', async () => {
  // A round in collection.
  const venue = await createVenue(pool, { products: [{ price: 9_000 }] })
  const ana = await join(venue.qrToken, 'Ana', 'pay_before_order')
  await addItem(pool, { sessionId: ana.session_id, participantId: ana.participant_id, productId: venue.menu[0].id })
  await closeRound(pool, { sessionId: ana.session_id })
  assert.equal((await call('switch_to_tab', ana.session_id, ana.participant_id)).reason, 'round_in_collection')
  assert.equal(await modeOf(ana.session_id), 'pay_before_order')

  // After the bill, table still open: the round in collection keeps it from closing.
  assert.equal((await call('request_bill', ana.session_id, ana.participant_id)).status, 'requested')
  assert.equal((await call('switch_to_tab', ana.session_id, ana.participant_id)).reason, 'bill_requested')

  // Already on a tab.
  const tabVenue = await createVenue(pool)
  const beto = await join(tabVenue.qrToken, 'Beto', 'open_tab')
  assert.equal((await call('switch_to_tab', beto.session_id, beto.participant_id)).reason, 'not_paying_each_round')

  // Closed: a paid table that asks for the bill with nothing owed closes on its own.
  const t = await paidFirstRound()
  assert.equal((await call('request_bill', t.s, t.ana)).closed, true)
  assert.equal((await call('switch_to_tab', t.s, t.ana)).reason, 'session_closed')

  // Someone from another table.
  const other = await paidFirstRound()
  assert.equal((await call('switch_to_tab', other.s, beto.participant_id)).reason, 'participant_not_in_session')
  assert.equal(await modeOf(other.s), 'pay_before_order')
})
