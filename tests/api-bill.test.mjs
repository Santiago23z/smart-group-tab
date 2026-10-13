// Smart Group Tab — asking for the bill and reserving the tab, over HTTP.
//
// The real diner server as a child process, against the test database: the
// routes are thin, but they are the only way a phone reaches these RPCs.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

import { connectionString, makePool, createVenue, joinSession, addItem, closeRound } from './helpers.mjs'

const pool = makePool(4)
after(() => pool.end())

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

async function startApi() {
  const port = await freePort()
  const child = spawn(process.execPath, ['src/api/server.mjs'], {
    env: { ...process.env, DATABASE_URL: connectionString, PORT: String(port), WOMPI_PRIVATE_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/state`); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  return {
    get: (path) => fetch(`${base}${path}`).then((r) => r.json()),
    post: (path, body) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json()),
    stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM') }),
  }
}

test('a diner asks for the bill, sees the tab, and reserves their part of it', async () => {
  const api = await startApi()
  try {
    const venue = await createVenue(pool, { serviceMode: 'open_tab', products: [{ price: 12_000 }, { price: 9_000 }] })
    const ana = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
    const beto = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Beto' })
    await addItem(pool, { sessionId: ana.session_id, participantId: ana.participant_id, productId: venue.menu[0].id })
    await addItem(pool, { sessionId: ana.session_id, participantId: beto.participant_id, productId: venue.menu[1].id })
    await closeRound(pool, { sessionId: ana.session_id })

    const bill = await api.post('/api/bill', { session_id: ana.session_id, participant_id: ana.participant_id })
    assert.equal(bill.status, 'requested')

    const state = await api.get(`/api/state?session_id=${ana.session_id}&participant_id=${ana.participant_id}`)
    assert.ok(state.session.bill_requested_at)
    assert.equal(Number(state.tab.total), 21_000)
    assert.deepEqual(state.tab.participants.map((p) => [p.nickname, Number(p.unpaid)]), [['Ana', 12_000], ['Beto', 9_000]])

    const r = await api.post('/api/reserve-tab', { session_id: ana.session_id, participant_id: ana.participant_id, mode: 'my_items', tip: 1000 })
    assert.equal(r.status, 'reserved')
    assert.equal(Number(r.order_amount), 12_000)

    const after = await api.get(`/api/state?session_id=${ana.session_id}&participant_id=${ana.participant_id}`)
    assert.equal(after.my_reservation.kind, 'tab')
    assert.equal(after.my_reservation.id, r.reservation_id)
    assert.equal(Number(after.tab.held), 12_000)
  } finally { await api.stop() }
})

test('before the bill a diner pays only their own part of a tab; the rest waits for the bill', async () => {
  const api = await startApi()
  try {
    const venue = await createVenue(pool, { serviceMode: 'open_tab', products: [{ price: 5_000 }] })
    const ana = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
    await addItem(pool, { sessionId: ana.session_id, participantId: ana.participant_id, productId: venue.menu[0].id })
    await closeRound(pool, { sessionId: ana.session_id })

    const rest = await api.post('/api/reserve-tab', { session_id: ana.session_id, participant_id: ana.participant_id, mode: 'remaining' })
    assert.deepEqual([rest.status, rest.reason], ['rejected', 'bill_not_requested'])
    const mine = await api.post('/api/reserve-tab', { session_id: ana.session_id, participant_id: ana.participant_id, mode: 'my_items' })
    assert.deepEqual([mine.status, Number(mine.order_amount)], ['reserved', 5_000])
  } finally { await api.stop() }
})

test('a diner asks to pay in cash, sees the request, and cancels it', async () => {
  const api = await startApi()
  try {
    const venue = await createVenue(pool, { serviceMode: 'open_tab', products: [{ price: 12_000 }] })
    const ana = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
    await addItem(pool, { sessionId: ana.session_id, participantId: ana.participant_id, productId: venue.menu[0].id })
    await closeRound(pool, { sessionId: ana.session_id })
    await api.post('/api/bill', { session_id: ana.session_id, participant_id: ana.participant_id })
    const who = { session_id: ana.session_id, participant_id: ana.participant_id }
    const state = () => api.get(`/api/state?session_id=${ana.session_id}&participant_id=${ana.participant_id}`)

    assert.equal((await state()).my_cash_request, null)
    const r = await api.post('/api/cash-request', { ...who, scope: 'mine', method: 'cash' })
    assert.deepEqual([r.status, Number(r.amount)], ['requested', 12_000])
    const open = (await state()).my_cash_request
    assert.deepEqual([open.id, open.method, open.scope, Number(open.amount)], [r.id, 'cash', 'mine', 12_000])

    assert.equal((await api.post('/api/cash-request/cancel', who)).status, 'cancelled')
    assert.equal((await state()).my_cash_request, null)
  } finally { await api.stop() }
})

test('the diner menu carries each dish\'s description', async () => {
  const api = await startApi()
  try {
    const venue = await createVenue(pool, { products: [{ price: 32_000 }, { price: 9_000 }] })
    const [picada, agua] = venue.menu.map((p) => p.id)
    await pool.query(`update products set description = 'Chorizo y arepa' where id = $1`, [picada])
    const ana = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
    const { menu } = await api.get(`/api/state?session_id=${ana.session_id}&participant_id=${ana.participant_id}`)
    assert.equal(menu.find((p) => p.id === picada).description, 'Chorizo y arepa')
    assert.equal(menu.find((p) => p.id === agua).description, null)
  } finally { await api.stop() }
})

test('the join screen asks the table, the opener chooses, and the table changes how it pays either way', async () => {
  const api = await startApi()
  try {
    const venue = await createVenue(pool, { products: [{ price: 15_000 }] })
    assert.deepEqual(await api.get(`/api/table?qr=${venue.qrToken}`), { status: 'free', venue: 'fixture', service_mode: null })
    assert.deepEqual(await api.get('/api/table?qr=nope'), { status: 'unknown' })

    const ana = await api.post('/api/join', { qr_token: venue.qrToken, nickname: 'Ana', mode: 'pay_before_order' })
    assert.deepEqual([ana.status, ana.service_mode, ana.chose], ['joined', 'pay_before_order', true])
    const beto = await api.post('/api/join', { qr_token: venue.qrToken, nickname: 'Beto', mode: 'open_tab' })
    assert.deepEqual([beto.service_mode, beto.chose], ['pay_before_order', false])
    assert.equal((await api.get(`/api/table?qr=${venue.qrToken}`)).service_mode, 'pay_before_order')

    // Refused while a round is in collection; allowed once nothing is.
    await addItem(pool, { sessionId: ana.session_id, participantId: ana.participant_id, productId: venue.menu[0].id })
    await closeRound(pool, { sessionId: ana.session_id })
    // Beto is paying his part right now: the table cannot change under him.
    const roundId = (await pool.query(`select id from rounds where session_id = $1 and status = 'locked_for_payment'`, [ana.session_id])).rows[0].id
    await pool.query(`select reserve_contribution($1, $2, 'remaining', $3, null, null, 0)`, [roundId, beto.participant_id, `api-${Math.random()}`])
    const refused = await api.post('/api/table-payment', { session_id: ana.session_id, participant_id: ana.participant_id, mode: 'open_tab' })
    assert.deepEqual([refused.status, refused.reason], ['rejected', 'someone_paying'])

    const fresh = await createVenue(pool)
    const solo = await api.post('/api/join', { qr_token: fresh.qrToken, nickname: 'Solo', mode: 'pay_before_order' })
    const toTab = await api.post('/api/table-payment', { session_id: solo.session_id, participant_id: solo.participant_id, mode: 'open_tab' })
    assert.equal(toTab.status, 'changed')
    let state = await api.get(`/api/state?session_id=${solo.session_id}&participant_id=${solo.participant_id}`)
    assert.equal(state.session.service_mode, 'open_tab')
    const back = await api.post('/api/table-payment', { session_id: solo.session_id, participant_id: solo.participant_id, mode: 'pay_before_order' })
    assert.equal(back.status, 'changed')
    state = await api.get(`/api/state?session_id=${solo.session_id}&participant_id=${solo.participant_id}`)
    assert.equal(state.session.service_mode, 'pay_before_order')

    const bad = await api.post('/api/join', { qr_token: fresh.qrToken, nickname: 'X', mode: 'hybrid' })
    assert.deepEqual([bad.status, bad.reason], ['rejected', 'invalid_mode'])
  } finally {
    await api.stop()
  }
})
