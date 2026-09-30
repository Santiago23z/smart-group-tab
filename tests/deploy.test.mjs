// Smart Group Tab — what the cloud needs that a laptop never did.
//
// On Railway each service deploys on its own, and each runs the migrations
// first. Two services deploying at once must not both apply the same
// migration: one would fail its deploy, or worse, leave the other half-applied.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import pg from 'pg'

import { testDatabaseUrl } from '../scripts/test-database.mjs'

const run = (cmd, args, env) => new Promise((resolve) => {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d))
  child.on('exit', (code) => resolve({ code, out }))
})

test('two services migrating a fresh database at once both succeed, and apply each migration once', async () => {
  const url = new URL(testDatabaseUrl())
  const name = `deploy_race_${Date.now()}_test`
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() })
  await admin.connect()
  await admin.query(`create database ${name}`)
  try {
    const target = Object.assign(new URL(url), { pathname: `/${name}` }).toString()
    const [a, b] = await Promise.all([
      run(process.execPath, ['scripts/db.mjs', 'migrate'], { DATABASE_URL: target }),
      run(process.execPath, ['scripts/db.mjs', 'migrate'], { DATABASE_URL: target }),
    ])
    assert.equal(a.code, 0, a.out)
    assert.equal(b.code, 0, b.out)

    const db = new pg.Client({ connectionString: target })
    await db.connect()
    const { rows } = await db.query(`select version, count(*) from schema_migrations group by version having count(*) > 1`)
    await db.end()
    assert.deepEqual(rows, [])
  } finally {
    await admin.query(`drop database ${name} with (force)`)
    await admin.end()
  }
})

test('the kitchen display listens on PORT when that is all the platform gives it', async () => {
  const { code, out } = await run(process.execPath, ['-e', `
    process.env.PORT = '8123'; delete process.env.KDS_PORT
    const { kdsPort } = await import('./src/kds/port.mjs'); console.log(kdsPort(process.env))`], {})
  assert.equal(code, 0, out)
  assert.equal(out.trim(), '8123')
})

test('one start command runs the service it is told to, and refuses a typo', async () => {
  const { code, out } = await run(process.execPath, ['src/start.mjs'], { RONDA_SERVICE: 'kitchn' })
  assert.notEqual(code, 0)
  assert.match(out, /RONDA_SERVICE must be one of web, wompi, kds, worker/)
})
