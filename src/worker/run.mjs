// Smart Group Tab — one pass over the outbox.
//
// The loop, and nothing else. Every decision it makes was made somewhere else:
// what is due is claim.mjs, what to send is deliver.mjs, what happens next is
// outcome.mjs. There is no backoff arithmetic and no retry branching in here,
// for the same reason there is none in src/wompi/server.mjs.

import { claimOne, record, leaseMsFor } from './claim.mjs'
import { deliver } from './deliver.mjs'
import { decide, summarise } from './outcome.mjs'
import { DEFAULTS } from './backoff.mjs'

/** Ceiling on one attempt. The lease is derived from it and must exceed it. */
export const DELIVERY_TIMEOUT_MS = 10_000

/**
 * Drain the queue until nothing is due, then return what happened.
 *
 * `hooks.afterDeliver` exists so a test can kill a worker at the one instant
 * that matters — after the ticket is on the wire and before the outcome is
 * recorded — which is the crash that makes delivery at-least-once rather than
 * exactly-once. It is not a production seam.
 */
export async function drain(client, {
  urls,
  config = DEFAULTS,
  deliverImpl = deliver,
  hooks = {},
  max = 100,
  timeoutMs = DELIVERY_TIMEOUT_MS,
  // Derived from the timeout, not tuned beside it: a lease shorter than an
  // attempt would hand the row to a second worker mid-POST.
  leaseMs = leaseMsFor(timeoutMs),
} = {}) {
  const done = { delivered: 0, retried: 0, failed: 0, skipped: 0 }

  for (let i = 0; i < max; i++) {
    const row = await claimOne(client, { leaseMs })
    if (!row) break

    const url = urls[row.channel]
    if (!url) {
      // Should be unreachable: the shell refuses to start without every URL.
      // If it ever happens, say so rather than silently leaving the row.
      throw new Error(`no destination configured for channel '${row.channel}'`)
    }

    let result
    try {
      result = await deliverImpl(url, row.ticket, { channel: row.channel, timeoutMs })
    } catch (err) {
      // deliver() is written not to throw; if something upstream of it does,
      // treat it as a failed attempt rather than losing the row.
      result = { ok: false, error: summarise(err) }
    }

    if (hooks.afterDeliver) await hooks.afterDeliver(row, result)

    const outcome = decide(result, row.attempts, config)
    await record(client, row.id, outcome)

    if (outcome.kind === 'delivered') done.delivered++
    else if (outcome.kind === 'retry') done.retried++
    else done.failed++
  }

  return done
}
