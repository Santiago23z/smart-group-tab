// Smart Group Tab — setting up a real bar: its menu from a spreadsheet, its
// tables, and a printable QR for each.
//
// The menu comes from whatever a bar owner exports from Excel or Google Sheets,
// so the parser is tested against what those actually produce. And the one
// thing a reload must never do is change a table's QR: those are printed and
// stuck on the tables.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makePool } from './helpers.mjs'
import { parseCsv, parseMenu, loadVenue } from '../src/admin/venue.mjs'
import { qrSheetHtml } from '../src/admin/qr-sheet.mjs'

const pool = makePool(4)
test.after(() => pool.end())

// ---------------------------------------------------------------------------
// Reading the spreadsheet
// ---------------------------------------------------------------------------
test('a CSV as Excel exports it: BOM, CRLF, quoted commas and quotes', () => {
  const text = '﻿categoria,nombre,precio,impuesto\r\nFuertes,"Lomo, papas y ensalada",42000,8\r\nBebidas,"Jugo ""natural""",9000,8%\r\n\r\n'
  assert.deepEqual(parseCsv(text), [
    ['categoria', 'nombre', 'precio', 'impuesto'],
    ['Fuertes', 'Lomo, papas y ensalada', '42000', '8'],
    ['Bebidas', 'Jugo "natural"', '9000', '8%'],
  ])
})

test('a CSV exported with semicolons, as Excel does in Spanish', () => {
  assert.deepEqual(parseCsv('nombre;precio\nCerveza;12000\n'), [['nombre', 'precio'], ['Cerveza', '12000']])
})

test('a menu reads Spanish or English headers, pesos and a tax percentage', () => {
  const menu = parseMenu(parseCsv('category,name,price,tax\nBebidas,Cerveza,"$12.000",8\nFuertes,Hamburguesa,28000,\n'))
  assert.deepEqual(menu, [
    { category: 'Bebidas', name: 'Cerveza', unitPrice: 12000, taxRate: 0.08 },
    { category: 'Fuertes', name: 'Hamburguesa', unitPrice: 28000, taxRate: 0 },
  ])
})

test('a menu with mistakes is refused with every mistake and its row', () => {
  const csv = 'categoria,nombre,precio,impuesto\nBebidas,Cerveza,doce mil,8\nBebidas,,9000,8\nBebidas,Agua,3000,120\nBebidas,Cerveza,12000,8\n'
  assert.throws(() => parseMenu(parseCsv(csv)), (err) => {
    assert.match(err.message, /fila 2: precio "doce mil"/)
    assert.match(err.message, /fila 3: falta el nombre/)
    assert.match(err.message, /fila 4: impuesto "120"/)
    assert.match(err.message, /fila 5: "Cerveza" está repetido/)
    return true
  })
})

test('a menu without the name or price column is refused', () => {
  assert.throws(() => parseMenu(parseCsv('plato,valor\nCerveza,12000\n')), /columnas "nombre" y "precio"/)
})

// ---------------------------------------------------------------------------
// Loading it
// ---------------------------------------------------------------------------
const uniqueName = () => `Bar de prueba ${Math.random().toString(36).slice(2)}`
const menuOf = async (venueId) => (await pool.query(
  `select name, category, unit_price, tax_rate, is_available from products where venue_id = $1 order by name`, [venueId])).rows
const tablesOf = async (venueId) => (await pool.query(
  `select label, qr_token, is_active from tables where venue_id = $1 order by created_at, label`, [venueId])).rows

test('a new bar gets its venue, numbered tables with random QR tokens, and its menu', async () => {
  const r = await loadVenue(pool, {
    name: uniqueName(), mode: 'open_tab', tables: 3, barSeats: 2,
    menu: [{ category: 'Bebidas', name: 'Cerveza', unitPrice: 12000, taxRate: 0.08 }],
  })

  const { rows: [venue] } = await pool.query(`select default_service_mode from venues where id = $1`, [r.venueId])
  assert.equal(venue.default_service_mode, 'open_tab')

  const tables = await tablesOf(r.venueId)
  assert.deepEqual(tables.map((t) => t.label).sort(), ['Barra 1', 'Barra 2', 'Mesa 1', 'Mesa 2', 'Mesa 3'])
  for (const t of tables) assert.match(t.qr_token, /^[a-z0-9]{20,}$/, 'not guessable like qr-test-mesa-12')
  assert.equal(new Set(tables.map((t) => t.qr_token)).size, 5)

  assert.deepEqual((await menuOf(r.venueId)).map((p) => [p.name, Number(p.unit_price), Number(p.tax_rate)]), [['Cerveza', 12000, 0.08]])
})

test('reloading updates prices, hides what left the menu, and never changes a printed QR', async () => {
  const name = uniqueName()
  const first = await loadVenue(pool, {
    name, mode: 'pay_before_order', tables: 2, barSeats: 0,
    menu: [
      { category: 'Bebidas', name: 'Cerveza', unitPrice: 12000, taxRate: 0.08 },
      { category: 'Bebidas', name: 'Michelada', unitPrice: 15000, taxRate: 0.08 },
    ],
  })
  const before = await tablesOf(first.venueId)

  const second = await loadVenue(pool, {
    name, mode: 'hybrid', tables: 3, barSeats: 0,
    menu: [
      { category: 'Bebidas', name: 'Cerveza', unitPrice: 13000, taxRate: 0.08 },
      { category: 'Fuertes', name: 'Hamburguesa', unitPrice: 28000, taxRate: 0.08 },
    ],
  })
  assert.equal(second.venueId, first.venueId, 'same bar, not a second one')

  const after = await tablesOf(first.venueId)
  assert.deepEqual(after.slice(0, 2).map((t) => t.qr_token), before.map((t) => t.qr_token))
  assert.equal(after.length, 3)

  assert.deepEqual((await menuOf(first.venueId)).map((p) => [p.name, Number(p.unit_price), p.is_available]), [
    ['Cerveza', 13000, true], ['Hamburguesa', 28000, true], ['Michelada', 15000, false],
  ])
  assert.deepEqual([second.summary.created, second.summary.updated, second.summary.hidden], [1, 1, 1])
})

test('fewer tables on reload deactivates the extra ones instead of deleting them', async () => {
  const name = uniqueName()
  const first = await loadVenue(pool, { name, mode: 'open_tab', tables: 3, barSeats: 0, menu: [{ category: null, name: 'Agua', unitPrice: 3000, taxRate: 0 }] })
  await loadVenue(pool, { name, mode: 'open_tab', tables: 2, barSeats: 0, menu: [{ category: null, name: 'Agua', unitPrice: 3000, taxRate: 0 }] })
  assert.deepEqual((await tablesOf(first.venueId)).map((t) => [t.label, t.is_active]), [['Mesa 1', true], ['Mesa 2', true], ['Mesa 3', false]])
})

test('an unknown mode is refused before anything is written', async () => {
  const name = uniqueName()
  await assert.rejects(loadVenue(pool, { name, mode: 'fiado', tables: 1, barSeats: 0, menu: [] }), /modo/)
  const { rows } = await pool.query(`select count(*) from venues where name = $1`, [name])
  assert.equal(rows[0].count, '0')
})

// ---------------------------------------------------------------------------
// The printable QR sheet
// ---------------------------------------------------------------------------
test('the QR sheet has one card per table, each encoding its own table\'s address', async () => {
  const html = await qrSheetHtml({
    venue: 'La Terraza',
    base: 'https://app.ronda.co',
    tables: [{ label: 'Mesa 1', qrToken: 'abc123' }, { label: 'Barra 1', qrToken: 'def456' }],
  })
  assert.equal((html.match(/<svg/g) ?? []).length, 2)
  assert.match(html, /Mesa 1/)
  assert.match(html, /https:\/\/app\.ronda\.co\/t\/abc123/)
  assert.match(html, /https:\/\/app\.ronda\.co\/t\/def456/)
  assert.match(html, /La Terraza/)
})
