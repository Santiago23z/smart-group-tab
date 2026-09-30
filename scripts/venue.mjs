#!/usr/bin/env node
// Smart Group Tab — set up a real bar, and print its table QR codes.
//
//   npm run venue:load -- --name "La Terraza" --mode open_tab --tables 12 --bar 3 --menu carta.csv
//   npm run venue:qr   -- --name "La Terraza" [--base https://app.ronda.co] [--out qr]
//
// --mode: pay_before_order (pagar antes de pedir), open_tab (cuenta abierta),
//         hybrid (híbrido). Loading again updates the menu and keeps every QR.

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { parseCsv, parseMenu, loadVenue } from '../src/admin/venue.mjs'
import { qrSheetHtml } from '../src/admin/qr-sheet.mjs'
import { reachableHost } from '../src/api/address.mjs'

const [command, ...rest] = process.argv.slice(2)
const args = {}
for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, '')] = rest[i + 1]

const fail = (msg) => { console.error(msg); process.exit(1) }
if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set.')
if (!args.name) fail('Falta --name "Nombre del bar".')

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 })

async function load() {
  if (!args.menu) fail('Falta --menu carta.csv')
  const menu = parseMenu(parseCsv(await readFile(args.menu, 'utf8')))
  const { venueId, summary } = await loadVenue(pool, {
    name: args.name,
    mode: args.mode ?? 'pay_before_order',
    tables: Number(args.tables ?? 0),
    barSeats: Number(args.bar ?? 0),
    menu,
  })
  console.log(`\n  ${args.name} (${venueId})`)
  console.log(`  Carta: ${summary.created} nuevos, ${summary.updated} actualizados, ${summary.hidden} ocultos`)
  console.log(`  Mesas activas: ${summary.tables.join(', ')}`)
  console.log(`\n  Siguiente: npm run venue:qr -- --name "${args.name}"\n`)
}

function lanAddress() {
  for (const i of Object.values(networkInterfaces()).flat()) if (i.family === 'IPv4' && !i.internal) return i.address
  return 'localhost'
}

// "Mesa 2" before "Mesa 10", tables before the bar.
const naturalOrder = (a, b) => a.label.localeCompare(b.label, 'es', { numeric: true })

async function qr() {
  const { rows } = await pool.query(
    `select t.label, t.qr_token from tables t join venues v on v.id = t.venue_id
      where v.name = $1 and t.is_active`, [args.name])
  if (rows.length === 0) fail(`No hay mesas activas para "${args.name}". ¿Corriste venue:load?`)
  const tables = rows.map((r) => ({ label: r.label, qrToken: r.qr_token }))
    .sort((a, b) => (a.label.startsWith('Barra') - b.label.startsWith('Barra')) || naturalOrder(a, b))

  // Until there is a real domain, the address phones on the same wifi can reach.
  const base = args.base ?? `http://${reachableHost(hostname(), lanAddress())}:8788`
  const html = await qrSheetHtml({ venue: args.name, base, tables })

  const dir = args.out ?? 'qr'
  const slug = args.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  await mkdir(dir, { recursive: true })
  const htmlPath = join(dir, `${slug}.html`)
  await writeFile(htmlPath, html)
  console.log(`\n  ${tables.length} QR → ${htmlPath}`)

  // A PDF too, if the browser the tests use is installed here.
  try {
    const { chromium } = await import('@playwright/test')
    const browser = await chromium.launch()
    const page = await browser.newPage()
    await page.setContent(html)
    await page.pdf({ path: join(dir, `${slug}.pdf`), format: 'A4', printBackground: true })
    await browser.close()
    console.log(`  PDF  → ${join(dir, `${slug}.pdf`)}`)
  } catch {
    console.log('  (Sin PDF: abrí el HTML y usá Imprimir → Guardar como PDF.)')
  }
  console.log(`  Dirección en los QR: ${base}\n`)
}

const commands = { load, qr }
if (!commands[command]) fail('Uso: node scripts/venue.mjs <load|qr> --name "Bar" ...')
try { await commands[command]() } catch (err) { fail(`\n  ${err.message}\n`) } finally { await pool.end() }
