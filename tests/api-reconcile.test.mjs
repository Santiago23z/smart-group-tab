// Smart Group Tab — checking a payment when the diner comes back from Wompi.
//
// The device only ever names a transaction id. Everything that decides the
// outcome — status, amount, reference — comes from our own call to Wompi, so
// these tests run the real app server against a fake Wompi and check that a
// device cannot talk its way into a settled round.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { createServer as createNetServer } from 'node:net'

import { connectionString, makePool, createFixture, reserve, roundState } from './helpers.mjs'

const pool = makePool(4)

// Fake Wompi: knows the transactions in `known`, 404s everything else.
const known = new Map()
let wompi
let wompiUrl
before(async () => {
  wompi = createServer((req, res) => {
    const id = decodeURIComponent(req.url.replace('/v1/transactions/', ''))
    const tx = req.headers.authorization === 'Bearer prv_test_fake' ? known.get(id) : undefined
    res.writeHead(tx ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(tx ? { data: tx } : { error: { type: 'NOT_FOUND_ERROR' } }))
  })
  await new Promise((r) => wompi.listen(0, '127.0.0.1', r))
  wompiUrl = `http://127.0.0.1:${wompi.address().port}/v1`
})
after(async () => {
  wompi.close()
  await pool.end()
})

const freePort = () => new Promise((resolve) => {
  const s = createNetServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

async function startApi(env) {
  const port = await freePort()
  const child = spawn(process.execPath, ['src/api/server.mjs'], {
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
      PORT: String(port),
      WOMPI_PUBLIC_KEY: 'pub_test_x',
      WOMPI_INTEGRITY_SECRET: 'test_integrity_x',
      WOMPI_REDIRECT_URL: '',
      WOMPI_API_URL: wompiUrl,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/state`); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  return {
    base,
    post: (path, body) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json()),
    stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM') }),
  }
}

async function reserved() {
  const f = await createFixture(pool, { participants: 1, items: [{ price: 15_000 }] })
  const claim = await reserve(pool, {
    roundId: f.roundId, participantId: f.participantIds[0], mode: 'remaining', key: `ret-${Math.random()}`,
  })
  return { ...f, claim }
}

const txFor = (claim, status = 'APPROVED') => {
  const tx = {
    id: `ret-${Math.random()}`, status, reference: claim.psp_reference,
    amount_in_cents: Number(claim.order_amount) * 100, currency: 'COP',
  }
  known.set(tx.id, tx)
  return tx
}

test('back from an approved checkout: settled at once, no webhook needed', async () => {
  const api = await startApi({ WOMPI_PRIVATE_KEY: 'prv_test_fake' })
  try {
    const f = await reserved()
    const tx = txFor(f.claim)
    const r = await api.post('/api/payments/reconcile', { transaction_id: tx.id })
    assert.equal(r.outcome, 'approved')
    assert.equal((await roundState(pool, f.roundId)).status, 'paid_and_dispatched')
  } finally { await api.stop() }
})

test('back from a declined checkout: the hold is released', async () => {
  const api = await startApi({ WOMPI_PRIVATE_KEY: 'prv_test_fake' })
  try {
    const f = await reserved()
    const r = await api.post('/api/payments/reconcile', { transaction_id: txFor(f.claim, 'DECLINED').id })
    assert.equal(r.outcome, 'declined')
  } finally { await api.stop() }
})

test('a pending transaction is reported as pending and changes nothing', async () => {
  const api = await startApi({ WOMPI_PRIVATE_KEY: 'prv_test_fake' })
  try {
    const f = await reserved()
    const r = await api.post('/api/payments/reconcile', { transaction_id: txFor(f.claim, 'PENDING').id })
    assert.equal(r.outcome, 'pending')
    assert.equal((await roundState(pool, f.roundId)).status, 'locked_for_payment')
  } finally { await api.stop() }
})

test('a forged transaction id settles nothing', async () => {
  const api = await startApi({ WOMPI_PRIVATE_KEY: 'prv_test_fake' })
  try {
    const f = await reserved()
    const r = await api.post('/api/payments/reconcile', {
      transaction_id: 'made-up',
      // Whatever else a device sends is ignored: only Wompi's answer counts.
      status: 'APPROVED', reference: f.claim.psp_reference, amount_in_cents: 1,
    })
    assert.deepEqual(r, { outcome: 'not_found' })
    assert.equal((await roundState(pool, f.roundId)).status, 'locked_for_payment')
  } finally { await api.stop() }
})

test('a real transaction for no reservation of ours settles nothing', async () => {
  const api = await startApi({ WOMPI_PRIVATE_KEY: 'prv_test_fake' })
  try {
    const tx = txFor({ psp_reference: `sgt-elsewhere-${Math.random()}`, order_amount: 1000 })
    assert.deepEqual(await api.post('/api/payments/reconcile', { transaction_id: tx.id }), { outcome: 'not_found' })
  } finally { await api.stop() }
})

test('without the private key the check is disabled', async () => {
  const api = await startApi({ WOMPI_PRIVATE_KEY: '' })
  try {
    assert.deepEqual(await api.post('/api/payments/reconcile', { transaction_id: 'x' }), { outcome: 'disabled' })
  } finally { await api.stop() }
})

/** POST with a chosen Host header, as a phone reaching us by name would send. */
function postAs(host, api, path, body) {
  const { port } = new URL(api.base)
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST',
      headers: { host, 'content-type': 'application/json' } }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve(JSON.parse(data)))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

async function redirectFor(api, { host } = {}) {
  const f = await reserved()
  const { rows } = await pool.query(
    `select t.qr_token from rounds r join sessions s on s.id = r.session_id join tables t on t.id = s.table_id
      where r.id = $1`, [f.roundId])
  const body = { reservation_id: f.claim.reservation_id }
  const intent = host
    ? await postAs(host, api, '/api/payments/intent', body)
    : await api.post('/api/payments/intent', body)
  return { redirect: new URL(intent.checkout_url).searchParams.get('redirect-url'), qr: rows[0].qr_token }
}

test('the checkout brings the diner back to the address they used', async () => {
  const api = await startApi({ WOMPI_PRIVATE_KEY: '' })
  try {
    const { redirect, qr } = await redirectFor(api, { host: 'mi-mac.local:8788' })
    assert.equal(redirect, `http://mi-mac.local:8788/t/${encodeURIComponent(qr)}`)
  } finally { await api.stop() }
})

test('reached by IP, the checkout carries no way back rather than being blocked', async () => {
  const api = await startApi({ WOMPI_PRIVATE_KEY: '' })
  try {
    const { redirect } = await redirectFor(api)
    assert.equal(redirect, null)
  } finally { await api.stop() }
})

test('WOMPI_REDIRECT_URL decides the way back when set', async () => {
  const api = await startApi({ WOMPI_PRIVATE_KEY: '', WOMPI_REDIRECT_URL: 'https://tab.example.com/ignored' })
  try {
    const { redirect, qr } = await redirectFor(api)
    assert.equal(redirect, `https://tab.example.com/t/${encodeURIComponent(qr)}`)
  } finally { await api.stop() }
})
