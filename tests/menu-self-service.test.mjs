// Smart Group Tab — a venue's own menu: sold out tonight, and uploads that
// never bring a sold-out dish back.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

import { connectionString, makePool, createVenue, joinSession, addItem } from './helpers.mjs'
import { loadMenu, parseCsv, parseMenu } from '../src/admin/venue.mjs'

const pool = makePool(4)
test.after(() => pool.end())

const call = async (fn, ...args) =>
  (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r
const product = async (id) => (await pool.query(`select * from products where id = $1`, [id])).rows[0]

async function openTable() {
  const venue = await createVenue(pool, { products: [{ price: 34_000 }, { price: 12_000 }] })
  const diner = await joinSession(pool, { qrToken: venue.qrToken, nickname: 'Ana' })
  return { venue, diner }
}

test('a sold-out dish cannot be added; what is already in the cart stays', async () => {
  const { venue, diner } = await openTable()
  const ceviche = venue.menu[0].id
  const before = await addItem(pool, { sessionId: diner.session_id, participantId: diner.participant_id, productId: ceviche })
  assert.equal(before.status, 'added')

  assert.equal((await call('staff_set_sold_out', venue.venueId, ceviche, true)).status, 'updated')
  const after = await addItem(pool, { sessionId: diner.session_id, participantId: diner.participant_id, productId: ceviche })
  assert.deepEqual([after.status, after.reason], ['rejected', 'product_unavailable'])

  const { rows } = await pool.query(`select count(*) from cart_items where round_id = $1 and status = 'active'`, [diner.round_id])
  assert.equal(rows[0].count, '1', 'the ceviche ordered before stays')

  await call('staff_set_sold_out', venue.venueId, ceviche, false)
  assert.equal((await addItem(pool, { sessionId: diner.session_id, participantId: diner.participant_id, productId: ceviche })).status, 'added')
})

test('a dish of another venue is refused, and changes are logged once', async () => {
  const a = await openTable()
  const b = await openTable()
  const r = await call('staff_set_sold_out', a.venue.venueId, b.venue.menu[0].id, true)
  assert.deepEqual([r.status, r.reason], ['rejected', 'product_of_another_venue'])
  assert.equal((await product(b.venue.menu[0].id)).sold_out, false)

  const dish = a.venue.menu[1].id
  await call('staff_set_sold_out', a.venue.venueId, dish, true)
  await call('staff_set_sold_out', a.venue.venueId, dish, true) // no change, no second entry
  await call('staff_set_sold_out', a.venue.venueId, dish, false)
  const { rows } = await pool.query(`select action from staff_action_log where target_id = $1 order by created_at`, [dish])
  assert.deepEqual(rows.map((x) => x.action), ['sold_out', 'back_in_stock'])
})

test('uploading the menu keeps a sold-out dish sold out, with its new price', async () => {
  const { venue } = await openTable()
  const [ceviche] = venue.menu
  const { rows: [{ name }] } = await pool.query(`select name from products where id = $1`, [ceviche.id])
  await call('staff_set_sold_out', venue.venueId, ceviche.id, true)

  const db = await pool.connect()
  try {
    await db.query('begin')
    await loadMenu(db, venue.venueId, [{ category: 'Fuertes', name, unitPrice: 36_000, taxRate: 0.08 }])
    await db.query('commit')
  } finally { db.release() }

  const p = await product(ceviche.id)
  assert.deepEqual([Number(p.unit_price), p.sold_out, p.is_available], [36_000, true, true])
})

test('a dry run reports what would change and writes nothing', async () => {
  const { venue } = await openTable()
  const names = (await pool.query(`select name from products where venue_id = $1 order by unit_price desc`, [venue.venueId])).rows.map((r) => r.name)
  const menu = [{ category: null, name: names[0], unitPrice: 40_000, taxRate: 0 }, { category: 'Postres', name: 'Brownie', unitPrice: 9_000, taxRate: 0.08 }]

  const db = await pool.connect()
  let preview
  try {
    await db.query('begin')
    preview = await loadMenu(db, venue.venueId, menu, { dryRun: true })
    await db.query('rollback')
  } finally { db.release() }

  assert.deepEqual(preview.added, ['Brownie'])
  assert.deepEqual(preview.updated, [names[0]])
  assert.deepEqual(preview.hidden, [names[1]])
  const { rows } = await pool.query(`select name, unit_price, is_available from products where venue_id = $1 order by name`, [venue.venueId])
  assert.equal(rows.length, 2, 'nothing added')
  assert.ok(rows.every((r) => r.is_available), 'nothing hidden')
})

test('menu errors come back as a list, one per mistake', () => {
  assert.throws(() => parseMenu(parseCsv('nombre,precio\nCerveza,doce\n,5000\n')), (err) => {
    assert.deepEqual(err.errors, ['fila 2: precio "doce" no es un número de pesos', 'fila 3: falta el nombre'])
    return true
  })
})

test('the diner menu drops a sold-out dish at once, and shows it again when back', async () => {
  const port = await new Promise((resolve) => {
    const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
  const child = spawn(process.execPath, ['src/api/server.mjs'], {
    env: { ...process.env, DATABASE_URL: connectionString, PORT: String(port) }, stdio: 'ignore',
  })
  try {
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/state`); break } catch { await new Promise((r) => setTimeout(r, 100)) } }
    const { venue, diner } = await openTable()
    const menuIds = async () => (await (await fetch(
      `${base}/api/state?session_id=${diner.session_id}&participant_id=${diner.participant_id}`)).json()).menu.map((p) => p.id)

    assert.ok((await menuIds()).includes(venue.menu[0].id))
    await call('staff_set_sold_out', venue.venueId, venue.menu[0].id, true)
    assert.ok(!(await menuIds()).includes(venue.menu[0].id))
    await call('staff_set_sold_out', venue.venueId, venue.menu[0].id, false)
    assert.ok((await menuIds()).includes(venue.menu[0].id))
  } finally {
    await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM') })
  }
})
