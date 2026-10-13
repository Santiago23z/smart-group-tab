// Smart Group Tab — the kitchen chooses how the venue collects. Only tables
// opened afterwards follow the new mode; a table already seated keeps its own.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool, createVenue, joinSession, addItem, closeRound } from './helpers.mjs'

const pool = makePool(8)
test.after(() => pool.end())

const call = async (fn, ...args) =>
  (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r
const modeOf = async (venueId) =>
  (await pool.query(`select default_service_mode::text as m from venues where id = $1`, [venueId])).rows[0].m
const logFor = async (venueId) =>
  (await pool.query(`select action, detail from staff_action_log where target_id = $1 order by created_at`, [venueId])).rows

/** A second free table at the same venue. */
async function anotherTable(venueId) {
  const qrToken = `qr-${Math.random().toString(36).slice(2)}`
  await pool.query(`insert into tables (venue_id, label, qr_token) values ($1, 'M2', $2)`, [venueId, qrToken])
  return qrToken
}

test('switching to an open tab: the next table runs a tab, the one already seated does not', async () => {
  const venue = await createVenue(pool, { products: [{ price: 15_000 }] })
  const seated = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })

  const r = await call('staff_set_service_mode', venue.venueId, 'open_tab')
  assert.deepEqual([r.status, r.mode, r.from], ['updated', 'open_tab', 'pay_before_order'])
  assert.equal(await modeOf(venue.venueId), 'open_tab')

  // Already seated: still collected before the kitchen.
  await addItem(pool, { sessionId: seated.session_id, participantId: seated.participant_id, productId: venue.menu[0].id })
  assert.equal((await closeRound(pool, { sessionId: seated.session_id })).status, 'collecting')

  // A table opened now: straight to the kitchen, unpaid.
  const fresh = await joinSession(pool, { qrToken: await anotherTable(venue.venueId), nickname: 'Beto' })
  const { rows: [s] } = await pool.query(`select service_mode::text as m from sessions where id = $1`, [fresh.session_id])
  assert.equal(s.m, 'open_tab')
  await addItem(pool, { sessionId: fresh.session_id, participantId: fresh.participant_id, productId: venue.menu[0].id })
  assert.equal((await closeRound(pool, { sessionId: fresh.session_id })).status, 'dispatched')
})

test('hybrid and anything else are refused, and change nothing', async () => {
  const venue = await createVenue(pool)
  for (const mode of ['hybrid', 'free_for_all', '', null]) {
    const r = await call('staff_set_service_mode', venue.venueId, mode)
    assert.deepEqual([r.status, r.reason], ['rejected', 'invalid_mode'], String(mode))
  }
  assert.equal(await modeOf(venue.venueId), 'pay_before_order')
  assert.deepEqual(await logFor(venue.venueId), [])
})

test('a venue already in hybrid can be switched to one of the two', async () => {
  const venue = await createVenue(pool, { serviceMode: 'hybrid' })
  const r = await call('staff_set_service_mode', venue.venueId, 'pay_before_order')
  assert.deepEqual([r.status, r.from], ['updated', 'hybrid'])
  assert.equal(await modeOf(venue.venueId), 'pay_before_order')
})

test('an unknown venue is refused', async () => {
  const r = await call('staff_set_service_mode', '00000000-0000-4000-8000-0000000000ff', 'open_tab')
  assert.deepEqual([r.status, r.reason], ['rejected', 'unknown_venue'])
})

test('a change is logged with its old and new mode; choosing the same mode logs nothing', async () => {
  const venue = await createVenue(pool)
  assert.equal((await call('staff_set_service_mode', venue.venueId, 'pay_before_order')).status, 'unchanged')
  assert.deepEqual(await logFor(venue.venueId), [])

  await call('staff_set_service_mode', venue.venueId, 'open_tab')
  assert.deepEqual(await logFor(venue.venueId),
    [{ action: 'set_service_mode', detail: { from: 'pay_before_order', to: 'open_tab' } }])
})
