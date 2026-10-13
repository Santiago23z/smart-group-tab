// Smart Group Tab — a table changes how it pays, both ways; a round in
// collection goes to the kitchen when its table switches to a tab; a diner at a
// tab pays their part before the bill. Every test asks the money questions:
// is anything dispatched twice, held twice, or paid twice?

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool, createVenue, addItem, closeRound, reserve, confirmWebhook } from './helpers.mjs'

const pool = makePool(8)
test.after(() => pool.end())

const call = async (fn, ...args) =>
  (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r
const key = () => `ftp-${Math.random()}`
const join = (qr, nickname, mode = null) => call('open_or_join_session', qr, nickname, mode)
const setMode = (s, p, mode) => call('set_table_payment', s, p, mode)
const one = async (sql, params) => (await pool.query(sql, params)).rows[0]
const tabTotal = async (s) => Number((await call('tab_summary', s)).total)
const roundStatus = async (id) => (await one(`select status::text as s from rounds where id = $1`, [id])).s
const dispatchRows = async (id) => Number((await one(`select count(*) as n from dispatches where round_id = $1`, [id])).n)
const approve = (r) => confirmWebhook(pool, { eventId: key(), reference: r.psp_reference, amount: Number(r.order_amount) + Number(r.tip_amount ?? 0) })

/** A table with Ana and Beto, each ordering one dish of the given prices. */
async function table(mode, [a, b] = [15_000, 15_000]) {
  const venue = await createVenue(pool, { products: [{ price: a }, { price: b }] })
  const ana = await join(venue.qrToken, 'Ana', mode)
  const beto = await join(venue.qrToken, 'Beto')
  const s = ana.session_id
  const order = async () => {
    await addItem(pool, { sessionId: s, participantId: ana.participant_id, productId: venue.menu[0].id })
    await addItem(pool, { sessionId: s, participantId: beto.participant_id, productId: venue.menu[1].id })
    return closeRound(pool, { sessionId: s })
  }
  return { venue, s, ana: ana.participant_id, beto: beto.participant_id, order }
}

// ---------------------------------------------------------------------------
// Changing how the table pays
// ---------------------------------------------------------------------------
test('to a tab and back: the draft round follows, and round 1 stays on the tab', async () => {
  const t = await table('pay_before_order')
  assert.deepEqual([(await setMode(t.s, t.ana, 'open_tab')).status], ['changed'])
  const r1 = await t.order()
  assert.equal(r1.status, 'dispatched', 'after the switch the round goes unpaid')

  const back = await setMode(t.s, t.beto, 'pay_before_order')
  assert.deepEqual([back.status, back.service_mode], ['changed', 'pay_before_order'])
  const r2 = await t.order()
  assert.equal(r2.status, 'collecting', 'back to paying each round')
  assert.equal(await tabTotal(t.s), 30_000, 'round 1 is still owed on the tab')
})

test('the same mode changes nothing', async () => {
  const t = await table('open_tab')
  assert.deepEqual((await setMode(t.s, t.ana, 'open_tab')).status, 'unchanged')
})

test('refusals: bill asked, closed, hybrid, a round needing staff, junk, a stranger', async () => {
  // Bill asked, tab still unpaid so the table stays open.
  const tab = await table('open_tab')
  await tab.order()
  await call('request_bill', tab.s, tab.ana)
  assert.equal((await setMode(tab.s, tab.ana, 'pay_before_order')).reason, 'bill_requested')

  // Closed: a table paying each round that asks for the bill with nothing owed.
  const paid = await table('pay_before_order')
  const r = await paid.order()
  await approve(await reserve(pool, { roundId: r.round_id, participantId: paid.ana, mode: 'remaining', key: key() }))
  assert.equal((await call('request_bill', paid.s, paid.ana)).closed, true)
  assert.equal((await setMode(paid.s, paid.ana, 'open_tab')).reason, 'session_closed')

  // Hybrid: only reachable through the venue's mode, and not switchable.
  const hv = await createVenue(pool, { serviceMode: 'hybrid' })
  const h = await join(hv.qrToken, 'Ana')
  assert.equal((await setMode(h.session_id, h.participant_id, 'open_tab')).reason, 'hybrid_table')

  // A round that needs staff.
  const st = await table('pay_before_order')
  const sr = await st.order()
  await pool.query(`update rounds set status = 'requires_staff_attention' where id = $1`, [sr.round_id])
  assert.equal((await setMode(st.s, st.ana, 'open_tab')).reason, 'round_needs_staff')

  assert.equal((await setMode(st.s, st.ana, 'hybrid')).reason, 'invalid_mode')
  assert.equal((await setMode(st.s, tab.ana, 'open_tab')).reason, 'participant_not_in_session')
})

test('never while someone is paying: a live round hold, or a live tab hold', async () => {
  // Beto is in the checkout for his part of a round in collection.
  const t = await table('pay_before_order')
  const r = await t.order()
  await reserve(pool, { roundId: r.round_id, participantId: t.beto, mode: 'my_items', key: key() })
  assert.equal((await setMode(t.s, t.ana, 'open_tab')).reason, 'someone_paying')
  assert.equal(await roundStatus(r.round_id), 'locked_for_payment')
  assert.equal(await dispatchRows(r.round_id), 0)
  assert.equal((await one(`select service_mode::text as m from sessions where id = $1`, [t.s])).m, 'pay_before_order')

  // At a tab, Ana is paying her part before the bill.
  const tab = await table('open_tab')
  await tab.order()
  const hold = await call('reserve_tab', tab.s, tab.ana, 'my_items', key(), 0)
  assert.equal(hold.status, 'reserved', JSON.stringify(hold))
  assert.equal((await setMode(tab.s, tab.beto, 'pay_before_order')).reason, 'someone_paying')
})

// ---------------------------------------------------------------------------
// The round in collection when the table switches to a tab
// ---------------------------------------------------------------------------
test('half paid, then switched: dispatched once, the paid half stays paid, the tab holds the rest', async () => {
  const t = await table('pay_before_order')
  const r = await t.order()
  await approve(await reserve(pool, { roundId: r.round_id, participantId: t.ana, mode: 'my_items', key: key() }))
  assert.equal(await roundStatus(r.round_id), 'locked_for_payment')

  const sw = await setMode(t.s, t.beto, 'open_tab')
  assert.deepEqual([sw.status, sw.dispatched_rounds], ['changed', [r.round_id]])
  assert.equal(await roundStatus(r.round_id), 'paid_and_dispatched')
  assert.equal(await dispatchRows(r.round_id), 2, 'one kds row and one print row')
  assert.equal(await tabTotal(t.s), 15_000, "only Beto's half is on the tab")
  assert.equal(await call('round_payment_state', r.round_id), 'unpaid')
})

test('two switches at the same moment dispatch the round once', async () => {
  const t = await table('pay_before_order')
  const r = await t.order()
  const answers = await Promise.all([setMode(t.s, t.ana, 'open_tab'), setMode(t.s, t.beto, 'open_tab')])
  assert.deepEqual(answers.map((a) => a.status).sort(), ['changed', 'unchanged'])
  assert.equal(await dispatchRows(r.round_id), 2)
})

test('a hold that lapsed before the switch, approved afterwards, is never paid twice', async () => {
  const t = await table('pay_before_order')
  const r = await t.order()
  const late = await reserve(pool, { roundId: r.round_id, participantId: t.beto, mode: 'my_items', key: key() })
  await pool.query(`update contribution_reservations set expires_at = now() - interval '1 minute' where id = $1`, [late.reservation_id])
  assert.equal((await setMode(t.s, t.ana, 'open_tab')).status, 'changed')

  const paid = await approve(late)
  const s = await one(`select status::text as status, prepaid_balance from sessions where id = $1`, [t.s])
  const settled = Number((await one(
    `select coalesce(sum(owed_amount), 0) as n from active_shares($1) x where is_share_settled(x.id)`, [r.round_id])).n)
  // His share was still unpaid and nobody else held it: the money is placed on it,
  // it leaves the tab, and nothing is credited.
  assert.equal(paid.status, 'settled')
  assert.equal(settled, 15_000)
  assert.equal(Number(s.prepaid_balance), 0)
  assert.equal(s.status, 'open')
  assert.equal(await tabTotal(t.s), 15_000)
  assert.equal(await dispatchRows(r.round_id), 2)
})

// ---------------------------------------------------------------------------
// Paying my part of a tab before the bill
// ---------------------------------------------------------------------------
test('at a tab, Ana pays her part before the bill and the table keeps ordering', async () => {
  const t = await table('open_tab', [20_000, 9_000])
  await t.order()
  const r = await call('reserve_tab', t.s, t.ana, 'my_items', key(), 0)
  assert.deepEqual([r.status, Number(r.order_amount)], ['reserved', 20_000])
  await approve(r)

  const s = await one(`select status::text as status, bill_requested_at from sessions where id = $1`, [t.s])
  assert.deepEqual([s.status, s.bill_requested_at], ['open', null])
  assert.equal(await tabTotal(t.s), 9_000)
  assert.equal((await t.order()).status, 'dispatched', 'the table can still order')
  assert.equal(await tabTotal(t.s), 38_000)
})

test('before the bill: not "the rest", and not at a table paying each round', async () => {
  const t = await table('open_tab')
  await t.order()
  assert.equal((await call('reserve_tab', t.s, t.ana, 'remaining', key(), 0)).reason, 'bill_not_requested')

  const p = await table('pay_before_order')
  assert.equal((await call('reserve_tab', p.s, p.ana, 'my_items', key(), 0)).reason, 'bill_not_requested')
})
