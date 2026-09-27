// Smart Group Tab — how a table's tab ends.
//
// An open tab used to have no ending: rounds went to the kitchen unpaid and
// nothing could pay them afterwards. These tests walk the whole ending — ask
// for the bill, pay the tab in one payment across rounds, write off what a
// departed table left, close — and ask of each step the same questions as the
// round path: can a share be held twice or paid twice, and is any approved
// payment lost?

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool, createVenue, joinSession, addItem, closeRound, reserve, confirmWebhook } from './helpers.mjs'

const pool = makePool(16)
test.after(() => pool.end())

const call = async (fn, ...args) =>
  (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r

const session = async (id) =>
  (await pool.query(`select status::text, bill_requested_at, prepaid_balance, closed_at from sessions where id = $1`, [id])).rows[0]

const tab = (id) => call('tab_summary', id)

/**
 * An open-tab table: two diners, each ordering in every round. `rounds` is a
 * list of [price for Ana, price for Beto]; each round is closed, so each goes
 * straight to the kitchen unpaid.
 */
async function openTab(rounds = [[20_000, 10_000], [8_000, 12_000]], { mode = 'open_tab' } = {}) {
  const prices = [...new Set(rounds.flat())]
  const venue = await createVenue(pool, { serviceMode: mode, products: prices.map((price) => ({ price })) })
  const product = (price) => venue.menu[prices.indexOf(price)].id
  const ana = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
  const beto = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Beto' })
  const sessionId = ana.session_id

  for (const [a, b] of rounds) {
    await addItem(pool, { sessionId, participantId: ana.participant_id, productId: product(a) })
    await addItem(pool, { sessionId, participantId: beto.participant_id, productId: product(b) })
    const closed = await closeRound(pool, { sessionId })
    if (mode === 'open_tab') assert.equal(closed.status, 'dispatched')
  }
  return { sessionId, qrToken: venue.qrToken, ana: ana.participant_id, beto: beto.participant_id, product, venue }
}

const key = () => `tab-${Math.random()}`
const event = () => `tab-evt-${Math.random()}`

/** Reserve the tab and have Wompi approve exactly what was reserved. */
async function payTab(sessionId, participantId, mode) {
  const r = await call('reserve_tab', sessionId, participantId, mode, key(), 0)
  assert.equal(r.status, 'reserved', JSON.stringify(r))
  const paid = await confirmWebhook(pool, { eventId: event(), reference: r.psp_reference, amount: r.order_amount })
  return { reservation: r, paid }
}

// ---------------------------------------------------------------------------
// What the tab is
// ---------------------------------------------------------------------------
test('an open tab is everything sent to the kitchen unpaid, per person', async () => {
  const t = await openTab([[20_000, 10_000], [8_000, 12_000], [5_000, 5_000]])
  const s = await tab(t.sessionId)
  assert.equal(Number(s.total), 60_000)
  const by = Object.fromEntries(s.participants.map((p) => [p.nickname, Number(p.unpaid)]))
  assert.deepEqual(by, { Ana: 33_000, Beto: 27_000 })
})

test('a pay-before-order table has no tab, and asking for the bill closes it', async () => {
  const venue = await createVenue(pool, { products: [{ price: 15_000 }] })
  const ana = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
  await addItem(pool, { sessionId: ana.session_id, participantId: ana.participant_id, productId: venue.menu[0].id })
  await closeRound(pool, { sessionId: ana.session_id })
  const r = await reserve(pool, { roundId: ana.round_id, participantId: ana.participant_id, mode: 'remaining', key: key() })
  await confirmWebhook(pool, { eventId: event(), reference: r.psp_reference, amount: r.order_amount })

  assert.equal(Number((await tab(ana.session_id)).total), 0)
  const bill = await call('request_bill', ana.session_id, ana.participant_id)
  assert.equal(bill.closed, true)
  assert.equal((await session(ana.session_id)).status, 'closed')
})

test('a hybrid round paid from the balance is recorded as paid and never owed', async () => {
  const venue = await createVenue(pool, { serviceMode: 'hybrid', products: [{ price: 30_000 }] })
  const ana = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
  const sessionId = ana.session_id
  await addItem(pool, { sessionId, participantId: ana.participant_id, productId: venue.menu[0].id })
  await closeRound(pool, { sessionId })
  const r = await reserve(pool, { roundId: ana.round_id, participantId: ana.participant_id, mode: 'remaining', key: key() })
  await confirmWebhook(pool, { eventId: event(), reference: r.psp_reference, amount: r.order_amount })
  await pool.query(`update sessions set prepaid_balance = 50000 where id = $1`, [sessionId])

  await addItem(pool, { sessionId, participantId: ana.participant_id, productId: venue.menu[0].id })
  const round2 = await closeRound(pool, { sessionId })
  assert.equal(round2.status, 'dispatched')

  const { rows: [r2] } = await pool.query(`select paid_from_balance from rounds where id = $1`, [round2.round_id])
  assert.equal(r2.paid_from_balance, true)
  assert.equal(Number((await tab(sessionId)).total), 0, 'charging it again would be paying twice')
})

// ---------------------------------------------------------------------------
// Asking for the bill
// ---------------------------------------------------------------------------
test('after asking for the bill nothing can be ordered, and asking twice changes nothing', async () => {
  const t = await openTab()
  const first = await call('request_bill', t.sessionId, t.ana)
  assert.deepEqual([first.status, first.already, first.closed], ['requested', false, false])
  assert.equal((await session(t.sessionId)).status, 'settling')

  const again = await call('request_bill', t.sessionId, t.beto)
  assert.equal(again.already, true)

  const added = await addItem(pool, { sessionId: t.sessionId, participantId: t.ana, productId: t.product(20_000) })
  assert.deepEqual([added.status, added.reason], ['rejected', 'session_closed'])
  assert.equal((await closeRound(pool, { sessionId: t.sessionId })).reason, 'session_closed')
})

test('the bill is refused while unsent items sit in the cart', async () => {
  const t = await openTab()
  await addItem(pool, { sessionId: t.sessionId, participantId: t.ana, productId: t.product(20_000) })
  const r = await call('request_bill', t.sessionId, t.ana)
  assert.deepEqual([r.status, r.reason], ['rejected', 'draft_not_empty'])
})

test('a flagged table in settlement still refuses orders, and returns to settling when cleared', async () => {
  const t = await openTab()
  await call('request_bill', t.sessionId, t.ana)
  // A late duplicate payment on a tab reservation: credited, table flagged.
  const { reservation } = await payTab(t.sessionId, t.ana, 'my_items')
  const dup = await confirmWebhook(pool, { eventId: event(), reference: reservation.psp_reference, amount: reservation.order_amount })
  assert.equal(dup.status, 'credited')
  assert.equal((await session(t.sessionId)).status, 'requires_staff_attention')

  const added = await addItem(pool, { sessionId: t.sessionId, participantId: t.beto, productId: t.product(10_000) })
  assert.equal(added.reason, 'session_closed', 'a flag must not reopen ordering')

  const refund = await call('staff_record_refund', dup.contribution_id, 'refunded', Number(reservation.order_amount), 'pagó dos veces')
  await call('staff_set_refund_status', refund.refund_id, 'completed')
  assert.equal((await session(t.sessionId)).status, 'settling')
})

// ---------------------------------------------------------------------------
// Paying the tab
// ---------------------------------------------------------------------------
test('"mine" pays every share of mine across all rounds, in one reservation', async () => {
  const t = await openTab([[20_000, 10_000], [8_000, 12_000]])
  await call('request_bill', t.sessionId, t.ana)
  const r = await call('reserve_tab', t.sessionId, t.ana, 'my_items', key(), 2000)
  assert.equal(Number(r.order_amount), 28_000)
  assert.equal(r.share_ids.length, 2)

  const paid = await confirmWebhook(pool, { eventId: event(), reference: r.psp_reference, amount: 30_000 })
  assert.equal(paid.status, 'settled')
  const s = await tab(t.sessionId)
  assert.equal(Number(s.total), 22_000)
  assert.deepEqual(s.participants.map((p) => p.nickname), ['Beto'])
})

test('the tab cannot be reserved before the bill', async () => {
  const t = await openTab()
  assert.equal((await call('reserve_tab', t.sessionId, t.ana, 'my_items', key(), 0)).reason, 'bill_not_requested')
})

test('two diners covering the rest at once: one holds it, the other gets nothing', async () => {
  for (let i = 0; i < 10; i++) {
    const t = await openTab()
    await call('request_bill', t.sessionId, t.ana)
    const results = await Promise.all([
      call('reserve_tab', t.sessionId, t.ana, 'remaining', key(), 0),
      call('reserve_tab', t.sessionId, t.beto, 'remaining', key(), 0),
    ])
    assert.deepEqual(results.map((r) => r.status).sort(), ['rejected', 'reserved'], JSON.stringify(results))
    assert.equal(results.find((r) => r.status === 'rejected').reason, 'nothing_available')
  }
})

test('a declined tab payment releases the hold; a retried webhook is a duplicate', async () => {
  const t = await openTab()
  await call('request_bill', t.sessionId, t.ana)
  const r = await call('reserve_tab', t.sessionId, t.ana, 'remaining', key(), 0)
  const declined = await confirmWebhook(pool, { eventId: event(), reference: r.psp_reference, outcome: 'declined', amount: r.order_amount })
  assert.equal(declined.status, 'released')
  assert.equal(Number((await tab(t.sessionId)).held), 0)

  const again = await call('reserve_tab', t.sessionId, t.beto, 'remaining', key(), 0)
  const evt = event()
  assert.equal((await confirmWebhook(pool, { eventId: evt, reference: again.psp_reference, amount: again.order_amount })).status, 'settled')
  assert.equal((await confirmWebhook(pool, { eventId: evt, reference: again.psp_reference, amount: again.order_amount })).status, 'duplicate_event')
})

test('a late tab payment for shares someone else paid is credited, never applied twice', async () => {
  const t = await openTab()
  await call('request_bill', t.sessionId, t.ana)
  const late = await call('reserve_tab', t.sessionId, t.ana, 'remaining', key(), 0)
  await pool.query(`update contribution_reservations set expires_at = now() - interval '1 minute' where id = $1`, [late.reservation_id])
  await payTab(t.sessionId, t.beto, 'remaining')

  // Beto's payment covered the whole tab, so the table already closed.
  assert.equal((await session(t.sessionId)).status, 'closed')

  const r = await confirmWebhook(pool, { eventId: event(), reference: late.psp_reference, amount: late.order_amount })
  assert.equal(r.status, 'credited')
  const s = await session(t.sessionId)
  assert.equal(Number(s.prepaid_balance), Number(late.order_amount))
  assert.equal(s.status, 'closed', 'its QR may already be seating the next party')

  // ...but the money is not invisible: staff still see it, and can refund it.
  const { rows: [{ r: alerts }] } = await pool.query(`select staff_alerts(interval '2 minutes') as r`)
  const listed = alerts.tables.find((a) => a.session_id === t.sessionId)
  assert.equal(listed.reasons[0].kind, 'money_not_placed')
  const refund = await call('staff_record_refund', r.contribution_id, 'refunded', Number(late.order_amount), 'pago tarde')
  await call('staff_set_refund_status', refund.refund_id, 'completed')
  const { rows: [{ r: after }] } = await pool.query(`select staff_alerts(interval '2 minutes') as r`)
  assert.equal(after.tables.find((a) => a.session_id === t.sessionId), undefined)
})

test('a late tab payment for shares staff wrote off is credited too', async () => {
  const t = await openTab()
  await call('request_bill', t.sessionId, t.ana)
  const late = await call('reserve_tab', t.sessionId, t.ana, 'remaining', key(), 0)
  await pool.query(`update contribution_reservations set expires_at = now() - interval '1 minute' where id = $1`, [late.reservation_id])
  assert.equal((await call('staff_write_off', t.sessionId, 'se fueron')).status, 'written_off')

  const r = await confirmWebhook(pool, { eventId: event(), reference: late.psp_reference, amount: late.order_amount })
  assert.equal(r.status, 'credited', 'a share is never both written off and paid')
})

// ---------------------------------------------------------------------------
// Write-off
// ---------------------------------------------------------------------------
test('a write-off covers the whole remaining tab, with its reason, and closes the table', async () => {
  const t = await openTab([[20_000, 10_000]])
  await call('request_bill', t.sessionId, t.ana)
  await payTab(t.sessionId, t.ana, 'my_items')

  const w = await call('staff_write_off', t.sessionId, 'Beto se fue sin pagar')
  assert.deepEqual([w.status, Number(w.amount), w.closed], ['written_off', 10_000, true])
  const { rows: [row] } = await pool.query(`select amount, reason from write_offs where id = $1`, [w.write_off_id])
  assert.deepEqual([Number(row.amount), row.reason], [10_000, 'Beto se fue sin pagar'])
  assert.equal((await session(t.sessionId)).status, 'closed')
})

test('a write-off is refused without a reason, before the bill, or while someone is paying', async () => {
  const t = await openTab()
  assert.equal((await call('staff_write_off', t.sessionId, 'x')).reason, 'bill_not_requested')
  await call('request_bill', t.sessionId, t.ana)
  assert.equal((await call('staff_write_off', t.sessionId, '  ')).reason, 'reason_required')
  await call('reserve_tab', t.sessionId, t.ana, 'my_items', key(), 0)
  assert.equal((await call('staff_write_off', t.sessionId, 'x')).reason, 'tab_held')
  assert.equal((await pool.query(`select count(*) from write_offs where session_id = $1`, [t.sessionId])).rows[0].count, '0')
})

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------
test('the last payment closes the table, and its QR opens a new session', async () => {
  const t = await openTab()
  await call('request_bill', t.sessionId, t.ana)
  await payTab(t.sessionId, t.ana, 'my_items')
  assert.equal((await session(t.sessionId)).status, 'settling')
  const { paid } = await payTab(t.sessionId, t.beto, 'my_items')
  assert.equal(paid.session_closed, true)

  const s = await session(t.sessionId)
  assert.equal(s.status, 'closed')
  assert.ok(s.closed_at)

  const next = await joinSession(pool, { qrToken: t.qrToken, nickname: 'Nueva' })
  assert.notEqual(next.session_id, t.sessionId)
})

test('closing is refused with every reason that still blocks it', async () => {
  const t = await openTab()
  const early = await call('staff_close_session', t.sessionId)
  assert.deepEqual(early.blockers.sort(), ['bill_not_requested', 'tab_unpaid'])

  await call('request_bill', t.sessionId, t.ana)
  await pool.query(`update sessions set prepaid_balance = 12000 where id = $1`, [t.sessionId])
  const { paid } = await payTab(t.sessionId, t.ana, 'remaining')
  assert.equal(paid.session_closed, false, 'credit left on the table keeps it open')
  const r = await call('staff_close_session', t.sessionId)
  assert.deepEqual([r.status, r.blockers], ['rejected', ['balance_left']])
})

test('a table with an open alert does not close, even with its tab paid', async () => {
  const t = await openTab([[20_000, 10_000]])
  // The kitchen never received round 1.
  await pool.query(`update dispatches set status = 'failed', attempts = 8, last_error = 'HTTP 503'
                     where round_id in (select id from rounds where session_id = $1) and channel = 'kds'`, [t.sessionId])
  await pool.query(`update sessions set status = 'requires_staff_attention' where id = $1`, [t.sessionId])
  await call('request_bill', t.sessionId, t.ana)
  const { paid } = await payTab(t.sessionId, t.ana, 'remaining')
  assert.equal(paid.session_closed, false)
  assert.deepEqual((await call('staff_close_session', t.sessionId)).blockers, ['alert_open'])

  // Retrying the delivery clears the alert, and with it the last blocker.
  const { rows: [d] } = await pool.query(
    `select d.id from dispatches d join rounds r on r.id = d.round_id where r.session_id = $1 and d.channel = 'kds'`, [t.sessionId])
  await call('staff_retry_dispatch', d.id)
  assert.equal((await session(t.sessionId)).status, 'closed')
})
