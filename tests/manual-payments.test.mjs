// Smart Group Tab — money received outside Wompi: cash and the card terminal.
//
// A manual payment is not a second way to write the ledger: it reserves and
// settles through the same functions a Wompi payment does. So each test asks
// whether cash behaves exactly like Wompi — shares paid once, the round
// released once, the table closed — and whether it leaves a record a human can
// read back.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool, createFixture, createVenue, joinSession, addItem, closeRound, reserve, roundState } from './helpers.mjs'

const pool = makePool(8)
test.after(() => pool.end())

const call = async (fn, ...args) =>
  (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r

const cash = (scope, target, participant, { method = 'cash', reference = null, tip = 0 } = {}) =>
  call('staff_record_manual_payment', scope, target, participant, method, reference, tip)

const record = async (id) =>
  (await pool.query(`select m.*, p.nickname, p.kind::text from manual_payments m
                       join participants p on p.id = m.participant_id where m.id = $1`, [id])).rows[0]

/** A round in collection: Ana owes 30.000, Beto 18.000. */
async function collecting() {
  return createFixture(pool, {
    participants: 2,
    items: [{ price: 30_000, owner: 0 }, { price: 18_000, owner: 1 }],
  })
}

/** An open tab with the bill asked for: Ana 25.000, Beto 15.000, over two rounds. */
async function tabInSettlement() {
  const venue = await createVenue(pool, { serviceMode: 'open_tab', products: [{ price: 25_000 }, { price: 15_000 }] })
  const ana = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
  const beto = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Beto' })
  const sessionId = ana.session_id
  await addItem(pool, { sessionId, participantId: ana.participant_id, productId: venue.menu[0].id })
  await closeRound(pool, { sessionId })
  await addItem(pool, { sessionId, participantId: beto.participant_id, productId: venue.menu[1].id })
  await closeRound(pool, { sessionId })
  await call('request_bill', sessionId, ana.participant_id)
  return { sessionId, ana: ana.participant_id, beto: beto.participant_id }
}

const sessionStatus = async (id) =>
  (await pool.query(`select status::text from sessions where id = $1`, [id])).rows[0].status

// ---------------------------------------------------------------------------
test('one diner\'s part of a round, in cash', async () => {
  const f = await collecting()
  const r = await cash('round', f.roundId, f.participantIds[0], { reference: 'mesa 3' })

  assert.equal(r.status, 'recorded')
  assert.equal(Number(r.amount), 30_000)
  const m = await record(r.manual_payment_id)
  assert.deepEqual([m.method, Number(m.amount), Number(m.tip), m.reference, m.nickname], ['cash', 30_000, 0, 'mesa 3', 'p0'])

  const state = await roundState(pool, f.roundId)
  assert.equal(state.status, 'locked_for_payment', 'Beto still owes his part')
  assert.equal(state.settledAmount, 30_000)
})

test('the rest on the card terminal releases the round to the kitchen, once', async () => {
  const f = await collecting()
  await cash('round', f.roundId, f.participantIds[0])
  const r = await cash('round', f.roundId, null, { method: 'card_terminal', reference: '0457', tip: 2000 })

  assert.equal(r.status, 'recorded')
  assert.equal(Number(r.amount), 18_000)
  const m = await record(r.manual_payment_id)
  assert.deepEqual([m.method, m.kind, m.nickname, Number(m.tip)], ['card_terminal', 'staff', 'Caja', 2000])

  const state = await roundState(pool, f.roundId)
  assert.equal(state.status, 'paid_and_dispatched')
  assert.equal(state.dispatchRows, 2)
  assert.equal((await cash('round', f.roundId, null)).reason, 'round_not_collectable', 'nothing more to take')
})

test('a tab paid in cash closes the table', async () => {
  const t = await tabInSettlement()
  const ana = await cash('tab', t.sessionId, t.ana)
  assert.equal(Number(ana.amount), 25_000)
  assert.equal(await sessionStatus(t.sessionId), 'settling')

  const rest = await cash('tab', t.sessionId, null, { method: 'card_terminal' })
  assert.equal(Number(rest.amount), 15_000)
  assert.equal(rest.session_closed, true)
  assert.equal(await sessionStatus(t.sessionId), 'closed')
})

test('shares someone is paying in Wompi are never taken', async () => {
  const f = await collecting()
  // Beto is inside the Wompi checkout for his part.
  const held = await reserve(pool, { roundId: f.roundId, participantId: f.participantIds[1], mode: 'my_items', key: `mp-${Math.random()}` })
  assert.equal(held.status, 'reserved')

  const beto = await cash('round', f.roundId, f.participantIds[1])
  assert.deepEqual([beto.status, beto.reason], ['rejected', 'nothing_available'])

  const rest = await cash('round', f.roundId, null)
  assert.equal(Number(rest.amount), 30_000, 'only Ana\'s free part, not Beto\'s held one')
  assert.equal((await roundState(pool, f.roundId)).status, 'locked_for_payment')
})

test('refused requests record nothing', async () => {
  const f = await collecting()
  const t = await tabInSettlement()
  const venue = await createVenue(pool, { serviceMode: 'open_tab', products: [{ price: 5_000 }] })
  const noBill = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Sin cuenta' })
  const unknown = '00000000-0000-4000-8000-00000000abcd'

  const cases = [
    [['round', f.roundId, null, 'bitcoin', null, 0], 'invalid_method'],
    [['round', f.roundId, null, 'cash', null, -1], 'invalid_tip'],
    [['galaxy', f.roundId, null, 'cash', null, 0], 'invalid_scope'],
    [['round', unknown, null, 'cash', null, 0], 'unknown_round'],
    [['tab', unknown, null, 'cash', null, 0], 'unknown_session'],
    [['round', f.roundId, t.ana, 'cash', null, 0], 'participant_not_in_session'],
    [['tab', noBill.session_id, null, 'cash', null, 0], 'bill_not_requested'],
  ]
  for (const [args, reason] of cases) {
    const r = await call('staff_record_manual_payment', ...args)
    assert.deepEqual([r.status, r.reason], ['rejected', reason], JSON.stringify(args))
  }
  const { rows } = await pool.query(
    `select count(*) from manual_payments where session_id = any($1)`, [[f.sessionId, t.sessionId, noBill.session_id]])
  assert.equal(rows[0].count, '0')
})

test('each manual payment is one ledger event, one contribution and one log entry', async () => {
  const f = await collecting()
  const r = await cash('round', f.roundId, f.participantIds[0], { method: 'card_terminal' })
  const m = await record(r.manual_payment_id)

  const { rows: [event] } = await pool.query(`select provider, payload from webhook_events where id = $1`, [m.webhook_event_id])
  assert.equal(event.provider, 'manual')
  assert.equal(event.payload.method, 'card_terminal')
  const { rows: contributions } = await pool.query(
    `select order_amount, applied_to_prepaid_balance from contributions where webhook_event_id = $1`, [m.webhook_event_id])
  assert.deepEqual(contributions.map((c) => [Number(c.order_amount), c.applied_to_prepaid_balance]), [[30_000, false]])
  const { rows: log } = await pool.query(`select action from staff_action_log where target_id = $1`, [m.id])
  assert.deepEqual(log.map((l) => l.action), ['manual_payment'])
})

test('the table\'s Caja is one participant, and never owes anything', async () => {
  const t = await tabInSettlement()
  const first = await call('session_caja', t.sessionId)
  assert.equal(await call('session_caja', t.sessionId), first)
  const { rows: [shares] } = await pool.query(`select count(*) from cart_item_shares where participant_id = $1`, [first])
  assert.equal(shares.count, '0')
})
