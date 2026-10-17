#!/usr/bin/env node
// Smart Group Tab — leave the demo bar as if the night had not started.
//
//   DATABASE_URL=... npm run demo:reset -- --yes
//
// Keeps the venue, tables (and their QR), menu and photos. Deletes every
// table session, order, payment, kitchen ticket and alert. Without --yes it
// only shows what it would delete. Refuses a database on another machine
// unless --remote is also given.

import pg from 'pg'
import { nightCounts, resetNight, isLocalDatabase } from '../src/admin/demo-reset.mjs'

const url = process.env.DATABASE_URL
const flags = new Set(process.argv.slice(2))
const fail = (msg) => { console.error(msg); process.exit(1) }

if (!url) fail('DATABASE_URL is not set.')
if (!isLocalDatabase(url) && !flags.has('--remote')) {
  fail('Esta base no está en este computador. Si de verdad es una demo, agrega --remote.')
}

const db = new pg.Client({ connectionString: url })
await db.connect()
try {
  const { pathname, hostname } = new URL(url)
  const before = await nightCounts(db)
  const nonEmpty = Object.entries(before).filter(([, n]) => n > 0)
  console.log(`\n  Base: ${pathname.slice(1)} en ${hostname}`)
  console.log(nonEmpty.length === 0
    ? '  Ya está limpia.'
    : nonEmpty.map(([t, n]) => `  ${String(n).padStart(6)}  ${t}`).join('\n'))

  if (!flags.has('--yes')) {
    console.log('\n  No se borró nada. Para borrar la noche: npm run demo:reset -- --yes\n')
  } else {
    const { backOnMenu } = await resetNight(db)
    console.log(`\n  Listo: mesas libres, cocina vacía, plata del día en cero.`)
    if (backOnMenu > 0) console.log(`  ${backOnMenu} plato(s) agotado(s) volvieron a la carta.`)
    console.log('  La carta, las fotos y los QR de las mesas siguen igual.\n')
  }
} finally {
  await db.end()
}
