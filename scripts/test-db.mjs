#!/usr/bin/env node
// Smart Group Tab — prepares the test database, then optionally runs a command
// against it.
//
//   node scripts/test-db.mjs                                   # create + migrate + seed
//   node scripts/test-db.mjs node scripts/audit-invariants.mjs # ...then run this on it
//
// Runs before `npm test` and `npm run test:e2e` (npm pre-scripts), so a fresh
// clone or a new migration needs no manual step.

import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { testDatabaseUrl } from './test-database.mjs'

const url = testDatabaseUrl()
const name = new URL(url).pathname.slice(1)
if (!/^[a-z0-9_]+$/.test(name)) {
  console.error(`Unexpected test database name "${name}".`)
  process.exit(1)
}

// A database cannot be created from inside itself: go through the server's
// maintenance database.
const adminUrl = new URL(url)
adminUrl.pathname = '/postgres'
const admin = new pg.Client({ connectionString: adminUrl.toString() })
await admin.connect()
const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name])
if (rowCount === 0) {
  await admin.query(`create database ${name}`)
  console.log(`Created ${name}.`)
}
await admin.end()

const env = { ...process.env, DATABASE_URL: url }
const run = (cmd, args) => spawnSync(cmd, args, { env, stdio: 'inherit' }).status

if (run(process.execPath, ['scripts/db.mjs', 'migrate']) !== 0) process.exit(1)

// The seed is plain inserts with fixed ids, so it runs once. The browser tests
// sit at tables of the seeded venue.
const db = new pg.Client({ connectionString: url })
await db.connect()
const seeded = (await db.query(`select 1 from venues where id = '00000000-0000-4000-8000-000000000001'`)).rowCount
await db.end()
if (!seeded && run(process.execPath, ['scripts/db.mjs', 'seed']) !== 0) process.exit(1)

const [cmd, ...args] = process.argv.slice(2)
if (cmd) process.exit(run(cmd, args) ?? 1)
