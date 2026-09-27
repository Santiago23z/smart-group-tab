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

test('the tab cannot be reserved before the bill', async () => {
  const api = await startApi()
  try {
    const venue = await createVenue(pool, { serviceMode: 'open_tab', products: [{ price: 5_000 }] })
    const ana = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
    const r = await api.post('/api/reserve-tab', { session_id: ana.session_id, participant_id: ana.participant_id, mode: 'my_items' })
    assert.deepEqual([r.status, r.reason], ['rejected', 'bill_not_requested'])
  } finally { await api.stop() }
})
