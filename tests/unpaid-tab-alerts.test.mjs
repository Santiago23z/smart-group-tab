// Smart Group Tab — who at an open table has owed for too long. A warning in
// the staff alerts, per person; it never flags the session and never keeps a
// flagged one flagged.
//
// staff_alerts() is global, so every assertion looks at its own session.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool, createVenue, addItem, closeRound, confirmWebhook } from './helpers.mjs'

const pool = makePool(8)
test.after(() => pool.end())

const call = async (fn, ...args) =>
  (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r
const key = () => `uta-${Math.random()}`
const listed = async (sessionId) =>
  (await pool.query(`select staff_alerts(interval '2 minutes', interval '90 minutes') as r`)).rows[0].r
    .tables.find((t) => t.session_id === sessionId)
const unpaidOf = (entry) => (entry?.reasons ?? []).filter((r) => r.kind === 'tab_unpaid_long')
const sessionStatus = async (id) =>
  (await pool.query(`select status::text as s from sessions where id = $1`, [id])).rows[0].s
const ago = (roundId, minutes) =>
  pool.query(`update rounds set dispatched_at = now() - make_interval(mins => $2) where id = $1`, [roundId, minutes])

/** A tab: Ana's dish went to the kitchen two hours ago, Beto's ten minutes ago. Both unpaid. */
async function tab() {
  const venue = await createVenue(pool, { serviceMode: 'open_tab', products: [{ price: 30_000 }, { price: 12_000 }] })
  const ana = await call('open_or_join_session', venue.qrToken, 'Ana', null)
  const beto = await call('open_or_join_session', venue.qrToken, 'Beto', null)
  const s = ana.session_id
  await addItem(pool, { sessionId: s, participantId: ana.participant_id, productId: venue.menu[0].id })
  const r1 = await closeRound(pool, { sessionId: s })
  await addItem(pool, { sessionId: s, participantId: beto.participant_id, productId: venue.menu[1].id })
  const r2 = await closeRound(pool, { sessionId: s })
  await ago(r1.round_id, 120)
  await ago(r2.round_id, 10)
  return { s, ana: ana.participant_id, beto: beto.participant_id, r1: r1.round_id, r2: r2.round_id }
}

test('Ana has owed for two hours: listed by name and amount, the table stays open, Beto is not named', async () => {
  const t = await tab()
  const entry = await listed(t.s)
  // Only the unpaid tab: a healthy table must not grow an "unknown" reason.
  assert.deepEqual(entry.reasons.map((r) => r.kind), ['tab_unpaid_long'])
  const reasons = unpaidOf(entry)
  assert.equal(reasons.length, 1)
  assert.deepEqual([reasons[0].nickname, Number(reasons[0].unpaid)], ['Ana', 30_000])
  assert.ok(Date.now() - Date.parse(reasons[0].unpaid_since) >= 119 * 60_000)
  assert.equal(await sessionStatus(t.s), 'open')

  // The open-tables panel has the same "since" per person.
  const people = (await call('tab_summary', t.s)).participants
  assert.ok(people.every((p) => p.unpaid_since))
})

test('a healthy open table is not listed', async () => {
  const t = await tab()
  await ago(t.r1, 10)
  assert.equal(await listed(t.s), undefined)
})

test('when Ana pays her part, the warning goes', async () => {
  const t = await tab()
  const r = await call('reserve_tab', t.s, t.ana, 'my_items', key(), 0)
  assert.equal(r.status, 'reserved', JSON.stringify(r))
  await confirmWebhook(pool, { eventId: key(), reference: r.psp_reference, amount: r.order_amount })
  assert.equal(await listed(t.s), undefined)
})

test('"Visto" covers it; Beto crossing the threshold later shows it again', async () => {
  const t = await tab()
  await call('acknowledge_alert', t.s, '90 minutes')
  assert.ok((await listed(t.s)).acknowledged_at)

  await ago(t.r2, 100)
  const entry = await listed(t.s)
  assert.deepEqual(unpaidOf(entry).map((r) => r.nickname), ['Ana', 'Beto'])
  assert.equal(entry.acknowledged_at, null)
})

test('it does not keep a flagged table flagged: resolving the real reason clears the flag', async () => {
  const t = await tab()
  // A delivery that failed for good flags the table.
  const { rows: [d] } = await pool.query(
    `update dispatches set status = 'failed', last_error = 'kitchen offline'
      where round_id = $1 and channel = 'kds' returning id`, [t.r2])
  await pool.query(`update sessions set status = 'requires_staff_attention' where id = $1`, [t.s])
  assert.deepEqual((await listed(t.s)).reasons.map((r) => r.kind).sort(), ['delivery_failed', 'tab_unpaid_long'])

  assert.equal((await call('staff_retry_dispatch', d.id)).status, 'retrying')
  assert.equal(await sessionStatus(t.s), 'open', 'an unpaid tab is a warning, not a flag')
  assert.deepEqual((await listed(t.s)).reasons.map((r) => r.kind), ['tab_unpaid_long'])
})
