#!/usr/bin/env node
// Smart Group Tab — migration runner.
//
// Deliberately not the Supabase CLI. The CLI needs Docker, and the phase 2
// concurrency tests need real parallel connections to a real Postgres — which is
// exactly what this gives us, against a local server or a hosted one, with no
// container runtime in between.
//
//   DATABASE_URL=postgres://... node scripts/db.mjs migrate
//   DATABASE_URL=postgres://... node scripts/db.mjs seed
//   DATABASE_URL=postgres://... node scripts/db.mjs reset    # drops and rebuilds

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = join(root, 'supabase', 'migrations')
const seedFile = join(root, 'supabase', 'seed.sql')

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

const client = new pg.Client({ connectionString })

async function migrate() {
  await client.query(`
    create table if not exists schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    )
  `)

  const { rows } = await client.query('select version from schema_migrations')
  const applied = new Set(rows.map((r) => r.version))

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  let ran = 0

  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await readFile(join(migrationsDir, file), 'utf8')

    // Each migration is one transaction: it either lands whole or not at all.
    await client.query('begin')
    try {
      await client.query(sql)
      await client.query('insert into schema_migrations (version) values ($1)', [file])
      await client.query('commit')
      console.log(`  applied  ${file}`)
      ran++
    } catch (err) {
      await client.query('rollback')
      console.error(`  FAILED   ${file}`)
      throw err
    }
  }

  console.log(ran === 0 ? 'Already up to date.' : `${ran} migration(s) applied.`)
}

async function seed() {
  const sql = await readFile(seedFile, 'utf8')
  await client.query(sql)
  console.log('Seeded.')
}

async function reset() {
  // public alone is not enough: the domain and the enums live there too, and
  // `drop schema cascade` is the only thing that reliably clears them.
  await client.query('drop schema if exists public cascade')
  await client.query('create schema public')
  await client.query('grant usage on schema public to public')
  console.log('Schema dropped.')
  await migrate()
  await seed()
}

const command = process.argv[2]
const commands = { migrate, seed, reset }

if (!commands[command]) {
  console.error(`Usage: node scripts/db.mjs <${Object.keys(commands).join('|')}>`)
  process.exit(1)
}

await client.connect()
try {
  await commands[command]()
} finally {
  await client.end()
}
