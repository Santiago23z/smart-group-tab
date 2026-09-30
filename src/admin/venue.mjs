// Setting up a real bar: its menu from a spreadsheet and its tables.
//
// Tooling, not a feature: it writes the same venues / tables / products rows
// the seed does, from what a bar owner can actually produce — a CSV exported
// from Excel or Google Sheets. Messages are in Spanish because the person
// reading them is.

import { randomBytes } from 'node:crypto'

const MODES = ['pay_before_order', 'open_tab', 'hybrid']

/**
 * RFC 4180-ish: quoted fields, doubled quotes, CRLF, a UTF-8 BOM, blank lines.
 * Excel in Spanish exports with semicolons, so the header line decides.
 */
export function parseCsv(text) {
  const clean = text.replace(/^﻿/, '')
  const firstLine = clean.split(/\r?\n/, 1)[0]
  const sep = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ','

  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === sep) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

const COLUMNS = {
  category: ['categoria', 'categoría', 'category'],
  name: ['nombre', 'name', 'producto'],
  price: ['precio', 'price'],
  tax: ['impuesto', 'tax', 'iva'],
}

const norm = (s) => s.trim().toLowerCase()

/** Rows (header first) to menu items; throws listing every mistake by row. */
export function parseMenu(rows) {
  const header = (rows[0] ?? []).map(norm)
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) =>
    [k, header.findIndex((h) => names.includes(h))]))
  if (col.name < 0 || col.price < 0) {
    throw new Error('La carta necesita las columnas "nombre" y "precio" (y opcionalmente "categoria" e "impuesto").')
  }

  const errors = []
  const seen = new Set()
  const items = []
  rows.slice(1).forEach((r, i) => {
    const line = i + 2
    const name = (r[col.name] ?? '').trim()
    const rawPrice = (r[col.price] ?? '').trim()
    const rawTax = col.tax >= 0 ? (r[col.tax] ?? '').trim() : ''

    if (!name) errors.push(`fila ${line}: falta el nombre`)

    // "$12.000", "12.000", "12000": Colombian pesos have no decimals.
    const digits = rawPrice.replace(/[$\s.,]/g, '')
    const unitPrice = /^\d+$/.test(digits) ? Number(digits) : NaN
    if (!(unitPrice > 0)) errors.push(`fila ${line}: precio "${rawPrice}" no es un número de pesos`)

    const pct = rawTax === '' ? 0 : Number(rawTax.replace('%', '').replace(',', '.'))
    if (!(pct >= 0 && pct < 100)) errors.push(`fila ${line}: impuesto "${rawTax}" debe ser un porcentaje entre 0 y 99`)

    if (name) {
      const key = norm(name)
      if (seen.has(key)) errors.push(`fila ${line}: "${name}" está repetido`)
      seen.add(key)
    }

    items.push({
      category: col.category >= 0 ? (r[col.category] ?? '').trim() || null : null,
      name,
      unitPrice,
      taxRate: Math.round(pct * 1000) / 100000,
    })
  })

  if (errors.length) {
    const err = new Error(`La carta tiene errores:\n  ${errors.join('\n  ')}`)
    err.errors = errors  // the staff screen lists them one by one
    throw err
  }
  return items
}

/** A token nobody can guess from the table's name, unlike qr-test-mesa-12. */
const newQrToken = () => randomBytes(16).toString('hex')

/**
 * Creates or updates a bar by name, in one transaction. Tables keep their QR
 * token forever — it is printed and stuck on the table. Menu items that left
 * the spreadsheet are hidden, not deleted: old bills still point at them.
 */
export async function loadVenue(pool, { name, mode, tables, barSeats = 0, menu }) {
  if (!MODES.includes(mode)) {
    throw new Error(`El modo "${mode}" no existe: usá pay_before_order, open_tab o hybrid.`)
  }
  for (const [label, n] of [['mesas', tables], ['barra', barSeats]]) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`El número de ${label} debe ser un entero de 0 en adelante.`)
  }
  const labels = [
    ...Array.from({ length: tables }, (_, i) => `Mesa ${i + 1}`),
    ...Array.from({ length: barSeats }, (_, i) => `Barra ${i + 1}`),
  ]

  const db = await pool.connect()
  try {
    await db.query('begin')
    let venueId = (await db.query(
      `select id from venues where name = $1 order by created_at limit 1 for update`, [name])).rows[0]?.id
    if (venueId) {
      await db.query(`update venues set default_service_mode = $2::service_mode where id = $1`, [venueId, mode])
    } else {
      venueId = (await db.query(
        `insert into venues (name, default_service_mode) values ($1, $2::service_mode) returning id`, [name, mode])).rows[0].id
    }

    for (const label of labels) {
      const { rowCount } = await db.query(
        `update tables set is_active = true where venue_id = $1 and label = $2`, [venueId, label])
      if (rowCount === 0) {
        await db.query(`insert into tables (venue_id, label, qr_token) values ($1, $2, $3)`, [venueId, label, newQrToken()])
      }
    }
    await db.query(
      `update tables set is_active = false where venue_id = $1 and not (label = any($2))`, [venueId, labels])

    const changes = await loadMenu(db, venueId, menu)
    await db.query('commit')
    return {
      venueId,
      summary: { created: changes.added.length, updated: changes.updated.length, hidden: changes.hidden.length, tables: labels },
    }
  } catch (err) {
    await db.query('rollback').catch(() => {})
    throw err
  } finally {
    db.release()
  }
}

/**
 * The menu half of loading a bar, on its own: what the staff screen's upload
 * runs. The caller holds the transaction. Dishes are matched by name; listed
 * ones are put back on the menu, the rest are hidden — never deleted, old bills
 * point at them. `sold_out` is never touched: an upload mid-service must not
 * bring back what ran out.
 *
 * With dryRun it does exactly the same writes inside a savepoint and rolls them
 * back, so a preview can never disagree with what applying would do.
 */
export async function loadMenu(db, venueId, menu, { dryRun = false } = {}) {
  if (dryRun) await db.query('savepoint menu_preview')

  const changes = { added: [], updated: [], hidden: [] }
  for (const item of menu) {
    const { rowCount } = await db.query(
      `update products set category = $3, unit_price = $4, tax_rate = $5, is_available = true
        where venue_id = $1 and name = $2`, [venueId, item.name, item.category, item.unitPrice, item.taxRate])
    if (rowCount) changes.updated.push(item.name)
    else {
      await db.query(
        `insert into products (venue_id, name, category, unit_price, tax_rate) values ($1, $2, $3, $4, $5)`,
        [venueId, item.name, item.category, item.unitPrice, item.taxRate])
      changes.added.push(item.name)
    }
  }
  changes.hidden = (await db.query(
    `update products set is_available = false
      where venue_id = $1 and is_available and not (name = any($2))
      returning name`, [venueId, menu.map((m) => m.name)])).rows.map((r) => r.name).sort()

  if (dryRun) await db.query('rollback to savepoint menu_preview')
  return changes
}
