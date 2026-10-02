// Smart Group Tab — a diner asks, from the app, to pay in cash or on the card
// terminal. The request moves nothing and holds nothing; it only tells the
// waiter where to go. Its amount is always what is still unpaid, so any
// payment route ends it.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool, createFixture, createVenue, joinSession, addItem, closeRound, reserve, confirmWebhook } from './helpers.mjs'

const pool = makePool(8)
test.after(() => pool.end())

const call = async (fn, ...args) =>
  (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r
const listed = async (sessionId) =>
  (await call('staff_cash_requests')).filter((r) => r.session_id === sessionId)

/** A round in collection: Ana (p0) owes 30.000, Beto (p1) 18.000. */
const collecting = () => createFixture(pool, { participants: 2, items: [{ price: 30_000, owner: 0 }, { price: 18_000, owner: 1 }] })

test('asking to pay my part in cash lists it for the waiter, and holds nothing', async () => {
  const f = await collecting()
  const r = await call('request_cash_payment', f.sessionId, f.participantIds[0], 'mine', 'cash')
  assert.deepEqual([r.status, Number(r.amount)], ['requested', 30_000])

  const [req] = await listed(f.sessionId)
  assert.deepEqual([req.nickname, Number(req.amount), req.method, req.target_scope, req.target_id, req.participant_id],
    ['p0', 30_000, 'cash', 'round', f.roundId, f.participantIds[0]])

  // Nothing held: Ana can still go to Wompi for the same part.
  const claim = await reserve(pool, { roundId: f.roundId, participantId: f.participantIds[0], mode: 'my_items', key: `cr-${Math.random()}` })
  assert.equal(claim.status, 'reserved')
})

test('"the rest" covers every unpaid share, on behalf of no one in particular', async () => {
  const f = await collecting()
  await call('request_cash_payment', f.sessionId, f.participantIds[1], 'rest', 'card_terminal')
  const [req] = await listed(f.sessionId)
  assert.deepEqual([Number(req.amount), req.method, req.participant_id], [48_000, 'card_terminal', null])
})

test('one open request per diner: a new one replaces the old; cancelling removes it', async () => {
  const f = await collecting()
  await call('request_cash_payment', f.sessionId, f.participantIds[0], 'mine', 'cash')
  await call('request_cash_payment', f.sessionId, f.participantIds[0], 'mine', 'card_terminal')
  const open = await listed(f.sessionId)
  assert.deepEqual(open.map((r) => r.method), ['card_terminal'])

  assert.equal((await call('cancel_cash_request', f.sessionId, f.participantIds[0])).status, 'cancelled')
  assert.deepEqual(await listed(f.sessionId), [])
})

test('the request follows what is unpaid, and ends when it is paid by any route', async () => {
  const f = await collecting()
  await call('request_cash_payment', f.sessionId, f.participantIds[0], 'rest', 'cash')
  assert.equal(Number((await listed(f.sessionId))[0].amount), 48_000)

  // Beto pays his part in Wompi: the request now says 30.000.
  const beto = await reserve(pool, { roundId: f.roundId, participantId: f.participantIds[1], mode: 'my_items', key: `cr-${Math.random()}` })
  await confirmWebhook(pool, { eventId: `cr-${Math.random()}`, reference: beto.psp_reference, amount: beto.order_amount })
  assert.equal(Number((await listed(f.sessionId))[0].amount), 30_000)

  // The waiter collects the rest in cash: nothing left, so nothing listed.
  await call('staff_record_manual_payment', 'round', f.roundId, null, 'cash', null, 0)
  assert.deepEqual(await listed(f.sessionId), [])
})

test('a held share still counts as unpaid, flagged for the waiter', async () => {
  const f = await collecting()
  await reserve(pool, { roundId: f.roundId, participantId: f.participantIds[0], mode: 'my_items', key: `cr-${Math.random()}` })
  await call('request_cash_payment', f.sessionId, f.participantIds[0], 'mine', 'cash')
  const [req] = await listed(f.sessionId)
  assert.deepEqual([Number(req.amount), Number(req.held)], [30_000, 30_000])
})

test('on an open tab after the bill, the request is for the tab', async () => {
  const venue = await createVenue(pool, { serviceMode: 'open_tab', products: [{ price: 25_000 }] })
  const ana = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
  await addItem(pool, { sessionId: ana.session_id, participantId: ana.participant_id, productId: venue.menu[0].id })
  await closeRound(pool, { sessionId: ana.session_id })
  await call('request_bill', ana.session_id, ana.participant_id)

  await call('request_cash_payment', ana.session_id, ana.participant_id, 'mine', 'cash')
  const [req] = await listed(ana.session_id)
  assert.deepEqual([req.target_scope, req.target_id, Number(req.amount)], ['tab', ana.session_id, 25_000])
})

test('refused when there is nothing to pay, or the input is wrong', async () => {
  const f = await collecting()
  const other = await collecting()
  const cases = [
    [[f.sessionId, f.participantIds[0], 'mine', 'bitcoin'], 'invalid_method'],
    [[f.sessionId, f.participantIds[0], 'everything', 'cash'], 'invalid_scope'],
    [[f.sessionId, other.participantIds[0], 'mine', 'cash'], 'participant_not_in_session'],
  ]
  for (const [args, reason] of cases) {
    const r = await call('request_cash_payment', ...args)
    assert.deepEqual([r.status, r.reason], ['rejected', reason])
  }
  await call('staff_record_manual_payment', 'round', f.roundId, f.participantIds[0], 'cash', null, 0)
  const nothing = await call('request_cash_payment', f.sessionId, f.participantIds[0], 'mine', 'cash')
  assert.deepEqual([nothing.status, nothing.reason], ['rejected', 'nothing_to_pay'])
})

test('staff dismiss a request, and it is logged', async () => {
  const f = await collecting()
  const { id } = await call('request_cash_payment', f.sessionId, f.participantIds[0], 'mine', 'cash')
  assert.equal((await call('staff_dismiss_cash_request', id)).status, 'dismissed')
  assert.deepEqual(await listed(f.sessionId), [])
  const { rows } = await pool.query(`select action from staff_action_log where target_id = $1`, [id])
  assert.deepEqual(rows.map((r) => r.action), ['dismiss_cash_request'])
})

test('paid in Wompi after all: the request disappears without anyone touching it', async () => {
  const f = await collecting()
  await call('request_cash_payment', f.sessionId, f.participantIds[0], 'mine', 'cash')
  const ana = await reserve(pool, { roundId: f.roundId, participantId: f.participantIds[0], mode: 'my_items', key: `cr-${Math.random()}` })
  await confirmWebhook(pool, { eventId: `cr-${Math.random()}`, reference: ana.psp_reference, amount: ana.order_amount })
  assert.deepEqual(await listed(f.sessionId), [])
})
