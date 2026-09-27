// Smart Group Tab — the kitchen display, fed by the real worker.
//
// The checks on a delivery are plain functions and are tested as such. The rest
// runs the real drain() against the real KDS server against the real database:
// the point of the KDS is that the chain from `dispatches` to a screen works,
// and a stub on either side would prove only the stub.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool, createFixture, reserve, confirmWebhook } from './helpers.mjs'
import { checkDelivery } from '../src/kds/ingest.mjs'
import { createKdsServer } from '../src/kds/app.mjs'
import { drain } from '../src/worker/run.mjs'

const pool = makePool()
const DISPATCH = 'dispatch-test-token'
const STAFF = 'staff-test-token'

const ROUND = '11111111-2222-3333-4444-555555555555'
const headers = (over = {}) => ({
  authorization: `Bearer ${DISPATCH}`,
  'x-dispatch-round': ROUND,
  'x-dispatch-channel': 'kds',
  ...over,
})
const body = (over = {}) => JSON.stringify({ round_id: ROUND, items: [], ...over })

// ---------------------------------------------------------------------------
test('checking a delivery', async (t) => {
  const check = (h, b = body(), channel = 'kds') =>
    checkDelivery({ channel, headers: h, rawBody: b, dispatchToken: DISPATCH })

  await t.test('a well-formed, authenticated ticket passes', () => {
    const v = check(headers())
    assert.equal(v.ok, true)
    assert.equal(v.roundId, ROUND)
  })

  await t.test('a forged or missing token is refused before anything else', () => {
    assert.equal(check(headers({ authorization: 'Bearer nope' })).status, 401)
    assert.equal(check(headers({ authorization: undefined })).status, 401)
    // Even a malformed body answers 401: an outsider learns nothing about shape.
    assert.equal(check(headers({ authorization: 'Bearer nope' }), 'not json').status, 401)
  })

  await t.test('a delivery that does not identify itself is refused', () => {
    assert.equal(check(headers({ 'x-dispatch-round': undefined })).reason, 'missing_round')
    assert.equal(check(headers({ 'x-dispatch-channel': 'print' })).reason, 'channel_mismatch')
    assert.equal(check(headers(), body(), 'fax').reason, 'unknown_channel')
  })

  await t.test('a body that is not a ticket is refused', () => {
    assert.equal(check(headers(), '{oops').reason, 'not_json')
    assert.equal(check(headers(), JSON.stringify({ round_id: ROUND })).reason, 'not_a_ticket')
    assert.equal(check(headers(), body({ round_id: '99999999-2222-3333-4444-555555555555' })).reason,
      'round_mismatch')
  })
})

// ---------------------------------------------------------------------------
async function startKds() {
  const server = createKdsServer({
    pool, dispatchToken: DISPATCH, staffToken: STAFF,
    log: { log() {}, error() {} },
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    urls: { kds: `${base}/ingest/kds`, print: `${base}/ingest/print` },
    staff: (path, init = {}) => fetch(`${base}${path}`, {
      ...init, headers: { authorization: `Bearer ${STAFF}`, ...(init.headers ?? {}) },
    }),
    close: () => new Promise((r) => server.close(r)),
  }
}

/** A released round with its two outbox rows, and every other row parked. */
async function releasedRound() {
  const fx = await createFixture(pool, {
    participants: 2, items: [{ price: 10_000 }, { price: 8_000 }], status: 'locked_for_payment',
  })
  await pool.query(
    `update rounds set status = 'paid_and_dispatched', dispatched_at = now() where id = $1`, [fx.roundId])
  await pool.query(
    `insert into dispatches (round_id, channel) values ($1, 'kds'), ($1, 'print')`, [fx.roundId])
  // drain() takes the whole queue by design; other files' rows are not ours.
  await pool.query(
    `update dispatches set next_attempt_at = now() + interval '1 hour'
      where status = 'pending' and round_id <> $1`, [fx.roundId])
  return fx
}

const ticketRow = async (roundId) => (await pool.query(
  `select receive_count, done_at from kitchen_tickets where round_id = $1`, [roundId])).rows

test('the worker feeds the kitchen screen', async (t) => {
  const kds = await startKds()
  const db = await pool.connect()
  t.after(async () => { db.release(); await kds.close() })

  await t.test('a released round ends up once on the screen, both rows delivered', async () => {
    const fx = await releasedRound()
    await drain(db, { urls: kds.urls, token: DISPATCH })

    const { rows } = await pool.query(
      `select channel, status from dispatches where round_id = $1 order by channel`, [fx.roundId])
    assert.deepEqual(rows.map((r) => r.status), ['delivered', 'delivered'])

    assert.equal((await ticketRow(fx.roundId)).length, 1)
    const state = await (await kds.staff('/kds/api/state')).json()
    const mine = state.tickets.filter((x) => x.round_id === fx.roundId)
    assert.equal(mine.length, 1)
    assert.equal(mine[0].items.length, 2)
    assert.equal(mine[0].table, 'M1')
    assert.ok(mine[0].items.every((i) => i.name && i.ordered_by && i.quantity === 1))
  })

  await t.test('a repeat delivery shows one order, and a done one stays done', async () => {
    const fx = await releasedRound()
    await drain(db, { urls: kds.urls, token: DISPATCH })

    // What the worker does after dying between the POST and the outcome write.
    await pool.query(
      `update dispatches set status = 'pending', delivered_at = null, next_attempt_at = now()
        where round_id = $1`, [fx.roundId])
    await drain(db, { urls: kds.urls, token: DISPATCH })
    let [row] = await ticketRow(fx.roundId)
    assert.equal(row.receive_count, 2)
    assert.equal((await ticketRow(fx.roundId)).length, 1)

    const res = await kds.staff(`/kds/api/tickets/${fx.roundId}/done`, { method: 'POST' })
    assert.equal(res.status, 200)

    await pool.query(
      `update dispatches set status = 'pending', delivered_at = null, next_attempt_at = now()
        where round_id = $1`, [fx.roundId])
    await drain(db, { urls: kds.urls, token: DISPATCH })
    ;[row] = await ticketRow(fx.roundId)
    assert.equal(row.receive_count, 3)
    assert.ok(row.done_at, 'a repeat reopened a ticket already sent out')

    const state = await (await kds.staff('/kds/api/state')).json()
    assert.ok(!state.tickets.some((x) => x.round_id === fx.roundId))

    // Marking done touched the ticket and nothing else.
    const { rows: [r] } = await pool.query(`select status from rounds where id = $1`, [fx.roundId])
    assert.equal(r.status, 'paid_and_dispatched')
  })

  await t.test('a worker with the wrong token leaves nothing on the screen', async () => {
    const fx = await releasedRound()
    await drain(db, { urls: kds.urls, token: 'not-the-token' })
    assert.equal((await ticketRow(fx.roundId)).length, 0)
    const { rows } = await pool.query(
      `select status, last_error from dispatches where round_id = $1`, [fx.roundId])
    assert.ok(rows.every((r) => r.status === 'pending' && /401/.test(r.last_error)))
    await pool.query(`update dispatches set next_attempt_at = now() + interval '1 day' where round_id = $1`,
      [fx.roundId])
  })

  await t.test('a ticket for a round the database does not know is refused', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000'
    const res = await fetch(kds.urls.kds, {
      method: 'POST',
      headers: { ...headers({ 'x-dispatch-round': ghost }), 'content-type': 'application/json' },
      body: body({ round_id: ghost }),
    })
    assert.equal(res.status, 422)
  })
})

// ---------------------------------------------------------------------------
test('the kitchen screen is for staff, and carries no money', async (t) => {
  const kds = await startKds()
  t.after(() => kds.close())

  await t.test('no staff token, no data', async () => {
    for (const [path, method] of [
      ['/kds/api/state', 'GET'],
      [`/kds/api/tickets/${ROUND}/done`, 'POST'],
      [`/kds/api/alerts/${ROUND}/ack`, 'POST'],
    ]) {
      const res = await fetch(`${kds.base}${path}`, { method })
      assert.equal(res.status, 401, `${method} ${path}`)
      assert.deepEqual(await res.json(), { error: 'staff_only' })
    }
    // The dispatch token is not a staff token.
    const res = await fetch(`${kds.base}/kds/api/state`,
      { headers: { authorization: `Bearer ${DISPATCH}` } })
    assert.equal(res.status, 401)
  })

  await t.test('a ticket posted with money in it shows none of it', async () => {
    const fx = await releasedRound()
    // An authenticated sender that got the payload wrong: the screen projects
    // named fields only, so the extras never reach it.
    const res = await fetch(kds.urls.kds, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${DISPATCH}`, 'content-type': 'application/json',
        'x-dispatch-round': fx.roundId, 'x-dispatch-channel': 'kds',
      },
      body: JSON.stringify({
        round_id: fx.roundId, round_number: 1, table: { label: 'M1' }, total: 18_000,
        items: [{ name: 'x', quantity: 1, ordered_by: 'p0', owed_amount: 9_000 }],
      }),
    })
    assert.equal(res.status, 200)
    await pool.query(`update dispatches set next_attempt_at = now() + interval '1 day' where round_id = $1`,
      [fx.roundId])

    const state = await (await kds.staff('/kds/api/state')).json()
    const text = JSON.stringify(state.tickets)
    assert.ok(text.includes(fx.roundId))
    assert.doesNotMatch(text, /amount|owed|total|balance|tip|psp/i)
  })

  await t.test('the static screen is served without a token and holds no data', async () => {
    const res = await fetch(`${kds.base}/kds`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /html/)
  })
})

test('staff act from the kitchen screen', async (t) => {
  const kds = await startKds()
  t.after(() => kds.close())
  const post = (path, body) => kds.staff(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })

  /** A table whose round was paid twice: the second payment is credit. */
  async function credited() {
    const fx = await createFixture(pool, { participants: 1, items: [{ price: 12_000 }] })
    const r = await reserve(pool, { roundId: fx.roundId, participantId: fx.participantIds[0], mode: 'remaining', key: `k-${Math.random()}` })
    const tag = Math.random()
    await confirmWebhook(pool, { eventId: `k1-${tag}`, reference: r.psp_reference, amount: r.order_amount })
    const second = await confirmWebhook(pool, { eventId: `k2-${tag}`, reference: r.psp_reference, amount: r.order_amount })
    return { ...fx, creditId: second.contribution_id, reference: r.psp_reference }
  }

  await t.test('the state carries open collections, without payment references', async () => {
    const fx = await createFixture(pool, { participants: 1, items: [{ price: 9_000 }] })
    const r = await reserve(pool, { roundId: fx.roundId, participantId: fx.participantIds[0], mode: 'remaining', key: `k-${Math.random()}` })
    const state = await (await kds.staff('/kds/api/state')).json()
    const mine = state.collections.find((c) => c.round_id === fx.roundId)
    assert.equal(Number(mine.outstanding), 9_000)
    assert.equal(mine.reservations[0].nickname, 'p0')
    assert.doesNotMatch(JSON.stringify(state), new RegExp(r.psp_reference))
    assert.doesNotMatch(JSON.stringify(state), /psp_reference|webhook|transaction/i)
  })

  await t.test('a refund goes through, and its alert clears when completed', async () => {
    const fx = await credited()
    const rec = await post('/kds/api/refunds', {
      contribution_id: fx.creditId, kind: 'refunded', amount: 12_000, reason: 'Pagó dos veces', external_reference: 'N-1',
    })
    assert.equal(rec.status, 200)
    const { refund_id: refundId } = await rec.json()

    const table = (s) => s.alerts.tables.find((a) => a.session_id === fx.sessionId)
    const pending = table(await (await kds.staff('/kds/api/state')).json())
    assert.equal(pending.reasons[0].refunds[0].status, 'pending')

    assert.equal((await post(`/kds/api/refunds/${refundId}/status`, { status: 'completed' })).status, 200)
    assert.equal(table(await (await kds.staff('/kds/api/state')).json()), undefined)
  })

  await t.test('a refused action answers 409 with its reason', async () => {
    const fx = await credited()
    const res = await post('/kds/api/refunds', { contribution_id: fx.creditId, kind: 'refunded', amount: 99_999, reason: 'x' })
    assert.equal(res.status, 409)
    assert.equal((await res.json()).reason, 'exceeds_payment')
  })

  await t.test('round, reservation and dispatch actions', async () => {
    const fx = await createFixture(pool, { participants: 2, items: [{ price: 9_000 }] })
    const r = await reserve(pool, { roundId: fx.roundId, participantId: fx.participantIds[0], mode: 'remaining', key: `k-${Math.random()}` })
    assert.equal((await (await post(`/kds/api/reservations/${r.reservation_id}/release`)).json()).status, 'released')
    assert.equal((await (await post(`/kds/api/rounds/${fx.roundId}/cancel`)).json()).status, 'cancelled')
    assert.equal((await post(`/kds/api/rounds/${fx.roundId}/resume`)).status, 409)

    const rel = await releasedRound()
    const { rows: [d] } = await pool.query(
      `update dispatches set status = 'failed', attempts = 8, next_attempt_at = now() + interval '1 day'
        where round_id = $1 and channel = 'kds' returning id`, [rel.roundId])
    assert.equal((await (await post(`/kds/api/dispatches/${d.id}/retry`)).json()).status, 'retrying')
  })

  await t.test('unknown and malformed targets', async () => {
    const unknown = '00000000-0000-4000-8000-00000000beef'
    for (const path of [`/kds/api/rounds/${unknown}/cancel`, `/kds/api/reservations/${unknown}/release`,
                        `/kds/api/dispatches/${unknown}/retry`, `/kds/api/refunds/${unknown}/status`]) {
      assert.equal((await post(path, { status: 'completed' })).status, 404, path)
    }
    assert.equal((await post('/kds/api/rounds/not-a-uuid/cancel')).status, 400)
    assert.equal((await post('/kds/api/refunds', { contribution_id: 'x', amount: 1, kind: 'refunded', reason: 'r' })).status, 400)
    assert.equal((await post('/kds/api/refunds', { contribution_id: unknown, amount: 1.5, kind: 'refunded', reason: 'r' })).status, 400)
  })

  await t.test('no staff token, no action — and the dispatch token is not one', async () => {
    const fx = await createFixture(pool, { participants: 1, items: [{ price: 9_000 }] })
    for (const auth of [undefined, `Bearer ${DISPATCH}`]) {
      const res = await fetch(`${kds.base}/kds/api/rounds/${fx.roundId}/cancel`, {
        method: 'POST', headers: auth ? { authorization: auth } : {},
      })
      assert.equal(res.status, 401)
    }
    const { rows: [round] } = await pool.query(`select status from rounds where id = $1`, [fx.roundId])
    assert.equal(round.status, 'locked_for_payment')
  })
})

test.after(() => pool.end())
