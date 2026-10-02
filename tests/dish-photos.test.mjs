// Smart Group Tab — one photo per dish.
//
// The images arrive already shrunk by the staff browser; the database's job
// is to keep them apart from the menu rows, tie each to its dish (and venue),
// give each version an address that changes when it does, and never let a
// menu upload touch them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

import { connectionString, makePool, createVenue, joinSession } from './helpers.mjs'
import { loadMenu } from '../src/admin/venue.mjs'

const pool = makePool(4)
test.after(() => pool.end())

const call = async (fn, ...args) =>
  (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r

// The bytes are not decoded anywhere server-side; a JPEG header is enough.
const jpeg = (n, fill = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, fill)])
const photo = async (productId) =>
  (await pool.query(`select hash, octet_length(thumb) as t, octet_length(large) as l, content_type from product_photos where product_id = $1`, [productId])).rows[0]

test('a photo is stored for its dish, and replacing it changes its hash', async () => {
  const v = await createVenue(pool, { products: [{ price: 34_000 }] })
  const dish = v.menu[0].id
  const first = await call('staff_set_photo', v.venueId, dish, jpeg(2000), jpeg(30_000), 'image/jpeg')
  assert.equal(first.status, 'updated')
  assert.match(first.hash, /^[0-9a-f]{16}$/)
  const stored = await photo(dish)
  assert.deepEqual([stored.t, stored.l, stored.content_type], [2004, 30_004, 'image/jpeg'])

  const second = await call('staff_set_photo', v.venueId, dish, jpeg(2000, 7), jpeg(30_000, 7), 'image/jpeg')
  assert.notEqual(second.hash, first.hash, 'a new photo gets a new address')
  assert.equal((await photo(dish)).hash, second.hash)
})

test('removing a photo leaves the dish without one', async () => {
  const v = await createVenue(pool, { products: [{ price: 9_000 }] })
  await call('staff_set_photo', v.venueId, v.menu[0].id, jpeg(100), jpeg(1000), 'image/jpeg')
  assert.equal((await call('staff_remove_photo', v.venueId, v.menu[0].id)).status, 'removed')
  assert.equal(await photo(v.menu[0].id), undefined)
})

test('refused: a dish of another venue, an unknown type, an oversized image', async () => {
  const a = await createVenue(pool, { products: [{ price: 9_000 }] })
  const b = await createVenue(pool, { products: [{ price: 9_000 }] })
  const cases = [
    [[a.venueId, b.menu[0].id, jpeg(10), jpeg(10), 'image/jpeg'], 'product_of_another_venue'],
    [[a.venueId, a.menu[0].id, jpeg(10), jpeg(10), 'image/gif'], 'invalid_type'],
    [[a.venueId, a.menu[0].id, jpeg(130_000), jpeg(10), 'image/jpeg'], 'too_large'],
    [[a.venueId, a.menu[0].id, jpeg(10), jpeg(800_000), 'image/jpeg'], 'too_large'],
  ]
  for (const [args, reason] of cases) {
    const r = await call('staff_set_photo', ...args)
    assert.deepEqual([r.status, r.reason], ['rejected', reason], reason)
  }
  assert.equal(await photo(a.menu[0].id), undefined)
  assert.equal(await photo(b.menu[0].id), undefined)
})

test('a menu upload keeps the photo, even through hiding and bringing the dish back', async () => {
  const v = await createVenue(pool, { products: [{ price: 34_000 }, { price: 12_000 }] })
  const [ceviche, other] = (await pool.query(`select id, name from products where venue_id = $1 order by unit_price desc`, [v.venueId])).rows
  const { hash } = await call('staff_set_photo', v.venueId, ceviche.id, jpeg(100), jpeg(1000), 'image/jpeg')

  const upload = async (menu) => {
    const db = await pool.connect()
    try { await db.query('begin'); await loadMenu(db, v.venueId, menu); await db.query('commit') } finally { db.release() }
  }
  await upload([{ category: null, name: ceviche.name, unitPrice: 36_000, taxRate: 0 }, { category: null, name: other.name, unitPrice: 12_000, taxRate: 0 }])
  assert.equal((await photo(ceviche.id)).hash, hash, 'price changed, photo kept')
  await upload([{ category: null, name: other.name, unitPrice: 12_000, taxRate: 0 }])
  await upload([{ category: null, name: ceviche.name, unitPrice: 36_000, taxRate: 0 }, { category: null, name: other.name, unitPrice: 12_000, taxRate: 0 }])
  assert.equal((await photo(ceviche.id)).hash, hash, 'hidden and back, photo kept')
})

test('every photo change is logged', async () => {
  const v = await createVenue(pool, { products: [{ price: 9_000 }] })
  const dish = v.menu[0].id
  await call('staff_set_photo', v.venueId, dish, jpeg(100), jpeg(1000), 'image/jpeg')
  await call('staff_remove_photo', v.venueId, dish)
  await call('staff_remove_photo', v.venueId, dish) // nothing to remove: no entry
  const { rows } = await pool.query(`select action from staff_action_log where target_id = $1 order by created_at`, [dish])
  assert.deepEqual(rows.map((r) => r.action), ['photo_set', 'photo_removed'])
})

test('diners get each photo from an address that changes with it, cached for good', async () => {
  const port = await new Promise((resolve) => {
    const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
  const child = spawn(process.execPath, ['src/api/server.mjs'], {
    env: { ...process.env, DATABASE_URL: connectionString, PORT: String(port) }, stdio: 'ignore',
  })
  try {
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/state`); break } catch { await new Promise((r) => setTimeout(r, 100)) } }
    const v = await createVenue(pool, { products: [{ price: 34_000 }, { price: 9_000 }] })
    const diner = await joinSession(pool, { qrToken: v.qrToken, nickname: 'Ana' })
    const [withPhoto, without] = v.menu.map((p) => p.id)
    const { hash } = await call('staff_set_photo', v.venueId, withPhoto, jpeg(500), jpeg(5000), 'image/jpeg')

    const menu = (await (await fetch(`${base}/api/state?session_id=${diner.session_id}&participant_id=${diner.participant_id}`)).json()).menu
    assert.equal(menu.find((p) => p.id === withPhoto).photo, hash)
    assert.equal(menu.find((p) => p.id === without).photo, null)

    const thumb = await fetch(`${base}/photos/${withPhoto}/${hash}/thumb.jpg`)
    assert.equal(thumb.status, 200)
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg')
    assert.match(thumb.headers.get('cache-control'), /max-age=31536000.*immutable/)
    assert.equal((await thumb.arrayBuffer()).byteLength, 504)
    assert.equal((await (await fetch(`${base}/photos/${withPhoto}/${hash}/large.jpg`)).arrayBuffer()).byteLength, 5004)

    // Replaced: the old address no longer serves anything, so no cache can mix them up.
    const { hash: next } = await call('staff_set_photo', v.venueId, withPhoto, jpeg(600, 9), jpeg(6000, 9), 'image/jpeg')
    assert.equal((await fetch(`${base}/photos/${withPhoto}/${hash}/thumb.jpg`)).status, 404)
    assert.equal((await fetch(`${base}/photos/${withPhoto}/${next}/thumb.jpg`)).status, 200)
    assert.equal((await fetch(`${base}/photos/${withPhoto}/${next}/huge.jpg`)).status, 404)
  } finally {
    await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM') })
  }
})
