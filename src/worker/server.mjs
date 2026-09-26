#!/usr/bin/env node
// Smart Group Tab — the dispatch outbox worker.
//
// Rows land in `dispatches` when a round is released to the kitchen. This is
// what delivers them. Without it the ledger is correct, every invariant holds,
// and nobody cooks anything — which is exactly the state this repo was in
// before it existed.
//
//   DATABASE_URL=... DISPATCH_KDS_URL=... DISPATCH_PRINT_URL=... DISPATCH_TOKEN=... node src/worker/server.mjs
//
// A shell, like src/wompi/server.mjs. Every decision lives in run.mjs,
// claim.mjs, deliver.mjs, outcome.mjs and backoff.mjs, none of which know this
// file exists.

import pg from 'pg'
import { drain } from './run.mjs'
import { DEFAULTS } from './backoff.mjs'

const connectionString = process.env.DATABASE_URL
const intervalMs = Number(process.env.DISPATCH_POLL_MS ?? 2_000)

// Both channels are enqueued by every released round and `npm run audit` asserts
// exactly two rows per round, so both must have somewhere to go. A channel with
// no destination would leave its rows pending forever — indistinguishable from a
// stuck delivery, which is the one signal this worker exists to give.
const urls = {
  kds: process.env.DISPATCH_KDS_URL,
  print: process.env.DISPATCH_PRINT_URL,
}

if (!connectionString) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

for (const [channel, url] of Object.entries(urls)) {
  if (!url) {
    console.error(`DISPATCH_${channel.toUpperCase()}_URL is not set. Refusing to start:`)
    console.error(`a worker that silently skips the '${channel}' channel leaves its rows`)
    console.error('pending forever, which is the failure this worker exists to prevent.')
    process.exit(1)
  }
}

// The receiver refuses tickets without it. Starting without one would fail every
// delivery until the attempts ran out, flagging every table in the venue.
const token = process.env.DISPATCH_TOKEN
if (!token) {
  console.error('DISPATCH_TOKEN is not set. Refusing to start: the kitchen display')
  console.error('rejects unauthenticated tickets, so every delivery would fail.')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString, max: 2 })

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // Finish the row in flight. Killing mid-delivery is survivable — the row
    // stays pending and is delivered again — but there is no reason to choose it.
    console.log(`\n  ${signal} — finishing the current dispatch and stopping.`)
    stopping = true
  })
}

console.log(`  Dispatch worker up. kds -> ${urls.kds}   print -> ${urls.print}`)
console.log(`  Polling every ${intervalMs}ms. Ctrl-C to stop.\n`)

while (!stopping) {
  const client = await pool.connect()
  try {
    const done = await drain(client, { urls, token, config: DEFAULTS })
    if (done.delivered || done.retried || done.failed) {
      console.log(
        `  delivered ${done.delivered}  retrying ${done.retried}  failed ${done.failed}`
      )
    }
  } catch (err) {
    // A worker that dies on a transient database error stops draining the queue
    // and nothing says so. Log it and come round again.
    console.error(`  [worker] ${err.message}`)
  } finally {
    client.release()
  }

  if (!stopping) await new Promise((r) => setTimeout(r, intervalMs))
}

await pool.end()
console.log('  Stopped.')
