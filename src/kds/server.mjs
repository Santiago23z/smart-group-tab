#!/usr/bin/env node
// Smart Group Tab — the kitchen display.
//
// The dispatch worker's destination for both channels, and the only staff
// surface the MVP has. A shell: every check lives in ingest.mjs and auth.mjs,
// every decision in SQL, and the routes in app.mjs.
//
//   DATABASE_URL=... DISPATCH_TOKEN=... KDS_STAFF_TOKEN=... npm run kds
//   then open http://<host>:8790/kds#token=<KDS_STAFF_TOKEN>

import pg from 'pg'
import { createKdsServer } from './app.mjs'

const port = Number(process.env.KDS_PORT ?? 8790)
const connectionString = process.env.DATABASE_URL
const dispatchToken = process.env.DISPATCH_TOKEN
const staffToken = process.env.KDS_STAFF_TOKEN
const stallMinutes = Number(process.env.KDS_STALL_MINUTES ?? 2)

if (!connectionString) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}
if (!dispatchToken) {
  console.error('DISPATCH_TOKEN is not set. Refusing to start: a kitchen display that')
  console.error('accepts tickets from anyone lets anyone have unpaid food cooked.')
  process.exit(1)
}
if (!staffToken) {
  console.error('KDS_STAFF_TOKEN is not set. Refusing to start: the screen shows every')
  console.error('table that needs staff, and it is not for diners.')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString, max: 4 })
const server = createKdsServer({ pool, dispatchToken, staffToken, stallMinutes })

server.listen(port, '0.0.0.0', () => {
  console.log(`\n  Kitchen display on http://localhost:${port}/kds#token=<KDS_STAFF_TOKEN>`)
  console.log(`  Worker destinations: DISPATCH_KDS_URL=http://localhost:${port}/ingest/kds`)
  console.log(`                       DISPATCH_PRINT_URL=http://localhost:${port}/ingest/print\n`)
})

const shutdown = async () => {
  server.close()
  await pool.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
