// Smart Group Tab — the demo reset empties a night and keeps the bar.
//
// Runs against the test database. It truncates every night table there, which
// is harmless: test files run one at a time and each builds its own venue.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { makePool, connectionString, createVenue, addItem, closeRound, confirmWebhook } from './helpers.mjs'
import { KEPT_TABLES, NIGHT_TABLES, nightCounts, resetNight, isLocalDatabase } from '../src/admin/demo-reset.mjs'

const pool = makePool(4)
test.after(() => pool.end())

const call = async (fn, ...args) =>
  (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r
const one = async (sql, params) => (await pool.query(sql, params)).rows[0]
const key = () => `reset-${Math.random()}`
const run = promisify(execFile)

/** A table that ordered, paid part of its tab, and a dish that ran out. */
async function night() {
  const venue = await createVenue(pool, { serviceMode: 'open_tab', products: [{ price: 20_000 }, { price: 9_000 }] })
  const ana = await call('open_or_join_session', venue.qrToken, 'Ana', 'open_tab')
  await addItem(pool, { sessionId: ana.session_id, participantId: ana.participant_id, productId: venue.menu[0].id })
  await closeRound(pool, { sessionId: ana.session_id })
  const r = await call('reserve_tab', ana.session_id, ana.participant_id, 'my_items', key(), 0)
  await confirmWebhook(pool, { eventId: key(), reference: r.psp_reference, amount: Number(r.order_amount) })
  await call('staff_set_sold_out', venue.venueId, venue.menu[1].id, true)
  await pool.query(
    `insert into product_photos (product_id, thumb, large, content_type, hash) values ($1, '\\x01', '\\x02', 'image/jpeg', 'h')`,
    [venue.menu[0].id])
  return venue
}

test('every table is either kept or emptied: a new table needs a decision', async () => {
  const { rows } = await pool.query(`select tablename from pg_tables where schemaname = 'public' order by 1`)
  const unknown = rows.map((r) => r.tablename).filter((t) => !KEPT_TABLES.includes(t) && !NIGHT_TABLES.includes(t))
  assert.deepEqual(unknown, [], 'add it to KEPT_TABLES or NIGHT_TABLES in src/admin/demo-reset.mjs')
})

test('a paid night is gone; the bar, its QR, the menu and the photos stay', async () => {
  const venue = await night()
  const before = await nightCounts(pool)
  for (const t of ['sessions', 'contributions', 'webhook_events', 'dispatches', 'staff_action_log']) {
    assert.ok(before[t] > 0, `the fixture should have filled ${t}`)
  }

  const db = await pool.connect()
  const { backOnMenu } = await resetNight(db).finally(() => db.release())
  assert.ok(backOnMenu >= 1)

  assert.ok(Object.values(await nightCounts(pool)).every((n) => n === 0), 'every night table is empty')
  assert.equal((await one(`select qr_token from tables where id = $1`, [venue.tableId])).qr_token, venue.qrToken)
  assert.equal(Number((await one(`select count(*) as n from products where venue_id = $1`, [venue.venueId])).n), 2)
  assert.equal(Number((await one(`select count(*) as n from product_photos where product_id = $1`, [venue.menu[0].id])).n), 1)
  assert.equal((await one(`select sold_out from products where id = $1`, [venue.menu[1].id])).sold_out, false)
  assert.equal(Number((await call('staff_takings_today')).total ?? 0), 0, 'takings start again from zero')

  // The printed QR still opens the table, as a fresh one.
  const again = await call('open_or_join_session', venue.qrToken, 'Beto', null)
  assert.ok(again.session_id)
})

test('only databases on this machine count as local', () => {
  assert.equal(isLocalDatabase('postgres://u@localhost:5432/x'), true)
  assert.equal(isLocalDatabase('postgres://u@127.0.0.1/x'), true)
  assert.equal(isLocalDatabase('postgres://u:p@db.railway.internal:5432/railway'), false)
})

test('the command deletes nothing without --yes, and refuses another machine', async () => {
  await night()
  const before = await nightCounts(pool)
  const { stdout } = await run('node', ['scripts/demo-reset.mjs'], { env: { ...process.env, DATABASE_URL: connectionString } })
  assert.match(stdout, /No se borró nada/)
  assert.deepEqual(await nightCounts(pool), before)

  const remote = await run('node', ['scripts/demo-reset.mjs', '--yes'], {
    env: { ...process.env, DATABASE_URL: 'postgres://u:p@db.example.com:5432/railway' },
  }).catch((e) => e)
  assert.equal(remote.code, 1)
  assert.match(remote.stderr, /no está en este computador/)
})
