// Smart Group Tab — the simulated payment must not coexist with a real rail.
//
// /api/dev/pay settles a reservation through confirm_webhook without any money
// moving. That is the whole point when there are no Wompi keys, and a hole the
// size of the menu when there are: anyone who can reach the server could have
// food released for free. Runs the real server as a child process, because the
// guard lives in its configuration, not in any function a test could import.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

import { connectionString, makePool, createFixture, reserve } from './helpers.mjs'

const pool = makePool(4)
test.after(() => pool.end())

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

async function startApi(env) {
  const port = await freePort()
  const child = spawn(process.execPath, ['src/api/server.mjs'], {
    env: { ...process.env, DATABASE_URL: connectionString, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/state`); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  return {
    post: (path, body) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json()),
    stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM') }),
  }
}

async function liveReservation() {
  const f = await createFixture(pool, { participants: 1, items: [{ price: 12_000 }] })
  const r = await reserve(pool, {
    roundId: f.roundId, participantId: f.participantIds[0], mode: 'remaining', key: `dev-${Math.random()}`,
  })
  assert.equal(r.status, 'reserved')
  return { ...f, reservationId: r.reservation_id }
}

const roundStatus = async (roundId) =>
  (await pool.query(`select status from rounds where id = $1`, [roundId])).rows[0].status

test('with Wompi configured, a simulated payment is refused and nothing settles', async () => {
  const api = await startApi({
    ALLOW_SIMULATED_PAYMENTS: 'true',
    WOMPI_PUBLIC_KEY: 'pub_test_x',
    WOMPI_INTEGRITY_SECRET: 'test_integrity_x',
  })
  try {
    const f = await liveReservation()
    const r = await api.post('/api/dev/pay', { reservation_id: f.reservationId })
    assert.deepEqual(r, { status: 'rejected', reason: 'wompi_configured' })
    assert.equal(await roundStatus(f.roundId), 'locked_for_payment')
  } finally { await api.stop() }
})

test('without Wompi keys, the simulated payment still settles', async () => {
  const api = await startApi({
    ALLOW_SIMULATED_PAYMENTS: 'true',
    WOMPI_PUBLIC_KEY: '',
    WOMPI_INTEGRITY_SECRET: '',
  })
  try {
    const f = await liveReservation()
    const r = await api.post('/api/dev/pay', { reservation_id: f.reservationId })
    assert.equal(r.status, 'settled')
    assert.equal(await roundStatus(f.roundId), 'paid_and_dispatched')
  } finally { await api.stop() }
})
