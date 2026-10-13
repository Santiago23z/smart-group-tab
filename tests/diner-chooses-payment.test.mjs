// Smart Group Tab — the diner chooses how the table pays: each round, or a tab
// paid at the end. Later diners follow the table; a table paying each round can
// switch to a tab, and what it already paid is never on the tab.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool, createVenue, addItem, closeRound } from './helpers.mjs'

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

// Changing how the table pays once seated: tests/flexible-table-payment.test.mjs.
