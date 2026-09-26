// Smart Group Tab — the worker's decisions, with nothing attached.
//
// No database, no DATABASE_URL, no socket. Every retry and failure path the
// worker can take is decided by these three functions, so this is where those
// paths get proven — not by sleeping through real backoff intervals and hoping
// something happened.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { DEFAULTS, backoffMs } from '../src/worker/backoff.mjs'
import { decide, summarise } from '../src/worker/outcome.mjs'
import { deliver } from '../src/worker/deliver.mjs'

const noJitter = () => 0

test('backoff', async (t) => {
  await t.test('grows with each failure', () => {
    const delays = [0, 1, 2, 3, 4].map((n) => backoffMs(n, DEFAULTS, noJitter))
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] > delays[i - 1], `attempt ${i} (${delays[i]}) did not grow past ${delays[i - 1]}`)
    }
  })

  await t.test('saturates at the cap and never exceeds it', () => {
    for (const n of [10, 20, 40, 1000]) {
      assert.ok(
        backoffMs(n, DEFAULTS, noJitter) <= DEFAULTS.capMs,
        `attempt ${n} exceeded the cap`
      )
    }
    // 2 ** 1024 is Infinity in JS; the exponent has to be clamped before the
    // shift or a long-failing row waits forever instead of at the cap.
    assert.ok(Number.isFinite(backoffMs(5000, DEFAULTS, noJitter)))
  })

  await t.test('is deterministic when the jitter source is', () => {
    const fixed = () => 0.5
    assert.equal(backoffMs(3, DEFAULTS, fixed), backoffMs(3, DEFAULTS, fixed))
  })

  await t.test('jitter only ever shortens, so the cap holds', () => {
    const maxJitter = () => 0.999
    for (const n of [0, 3, 10, 99]) {
      const jittered = backoffMs(n, DEFAULTS, maxJitter)
      assert.ok(jittered <= backoffMs(n, DEFAULTS, noJitter))
      assert.ok(jittered <= DEFAULTS.capMs)
      assert.ok(jittered >= 0)
    }
  })

  await t.test('refuses a nonsensical attempt count rather than guessing', () => {
    assert.throws(() => backoffMs(-1), /non-negative/)
    assert.throws(() => backoffMs(1.5), /integer/)
  })
})

test('the outcome decision', async (t) => {
  await t.test('success is terminal and asks for nothing else', () => {
    assert.deepEqual(decide({ ok: true }, 0), { kind: 'delivered' })
    assert.deepEqual(decide({ ok: true }, 7), { kind: 'delivered' })
  })

  await t.test('a failure below the ceiling schedules another attempt', () => {
    const d = decide({ ok: false, error: 'ECONNREFUSED' }, 0, DEFAULTS, noJitter)
    assert.equal(d.kind, 'retry')
    assert.equal(d.attempts, 1)
    assert.equal(d.error, 'ECONNREFUSED')
    assert.ok(d.delayMs > 0)
  })

  await t.test('the failure that crosses the ceiling is terminal', () => {
    const last = decide({ ok: false, error: 'boom' }, DEFAULTS.maxAttempts - 2, DEFAULTS, noJitter)
    assert.equal(last.kind, 'retry', 'one short of the ceiling should still retry')

    const over = decide({ ok: false, error: 'boom' }, DEFAULTS.maxAttempts - 1, DEFAULTS, noJitter)
    assert.equal(over.kind, 'failed')
    assert.equal(over.attempts, DEFAULTS.maxAttempts)
    assert.equal(over.error, 'boom')
  })

  await t.test('a failure with no reason still records something a human can read', () => {
    const d = decide({ ok: false }, 0, DEFAULTS, noJitter)
    assert.match(d.error, /without a reason/)
  })

  await t.test('errors are flattened and bounded', () => {
    const noisy = new Error('line one\n   line two\t\tline three')
    assert.equal(summarise(noisy), 'line one line two line three')
    assert.equal(summarise(new Error('x'.repeat(5000))).length, 500)
    assert.equal(summarise(null), 'unknown error')
  })
})

// ---------------------------------------------------------------------------
// Delivery, against a real socket but no database.
// ---------------------------------------------------------------------------
async function stub(handler) {
  const server = createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/`
  return { url, close: () => new Promise((r) => server.close(r)) }
}

const TICKET = { round_id: 'r-1', round_number: 1, items: [] }

test('delivery', async (t) => {
  await t.test('a 2xx is success', async () => {
    const s = await stub((req, res) => { res.writeHead(200); res.end('ok') })
    try {
      assert.deepEqual(await deliver(s.url, TICKET, { channel: 'kds' }), { ok: true })
    } finally { await s.close() }
  })

  await t.test('the ticket and its idempotency key arrive intact', async () => {
    let seen = null
    const s = await stub((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen = { headers: req.headers, body: JSON.parse(body), method: req.method }
        res.writeHead(200); res.end()
      })
    })
    try {
      await deliver(s.url, TICKET, { channel: 'print', token: 's3cret' })
      assert.equal(seen.method, 'POST')
      // The receiver's only proof that this ticket came from the worker, and
      // not from anyone on the venue network wanting unpaid food cooked.
      assert.equal(seen.headers.authorization, 'Bearer s3cret')
      assert.deepEqual(seen.body, TICKET)
      // Delivery is at-least-once by construction; this pair is what lets the
      // receiver collapse a repeat into one order.
      assert.equal(seen.headers['x-dispatch-round'], 'r-1')
      assert.equal(seen.headers['x-dispatch-channel'], 'print')
    } finally { await s.close() }
  })

  await t.test('a non-2xx is a failure carrying the status', async () => {
    const s = await stub((req, res) => { res.writeHead(503); res.end('kitchen down') })
    try {
      const r = await deliver(s.url, TICKET, { channel: 'kds' })
      assert.equal(r.ok, false)
      assert.match(r.error, /503/)
      assert.match(r.error, /kitchen down/)
    } finally { await s.close() }
  })

  await t.test('an unreachable destination is a failure, not a throw', async () => {
    const r = await deliver('http://127.0.0.1:1/', TICKET, { channel: 'kds' })
    assert.equal(r.ok, false)
    assert.ok(r.error.length > 0)
  })

  await t.test('a destination that accepts and then says nothing times out', async () => {
    // The failure an outbox must survive: without the timeout this worker waits
    // forever and the queue stops draining while everything looks healthy.
    const s = await stub(() => { /* never responds */ })
    try {
      const r = await deliver(s.url, TICKET, { channel: 'kds', timeoutMs: 150 })
      assert.equal(r.ok, false)
      assert.match(r.error, /timed out/)
    } finally { await s.close() }
  })
})
