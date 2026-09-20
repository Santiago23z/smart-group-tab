// Smart Group Tab — what to do with a dispatch after an attempt.
//
// The whole retry policy, with no database and no socket in it. The worker shell
// applies what this returns; it never decides anything itself.

import { DEFAULTS, backoffMs } from './backoff.mjs'

/**
 * @param result   { ok: true } | { ok: false, error: string }
 * @param attempts failures recorded on the row BEFORE this attempt
 * @returns
 *   { kind: 'delivered' }
 *   { kind: 'retry',  attempts, delayMs, error }
 *   { kind: 'failed', attempts, error }
 */
export function decide(result, attempts, config = DEFAULTS, random = Math.random) {
  if (result?.ok) return { kind: 'delivered' }

  const next = attempts + 1
  const error = result?.error ?? 'delivery failed without a reason'

  // Terminal. Retrying forever would leave a permanently broken destination
  // indistinguishable from a merely slow one, and nobody would ever learn that
  // paid food is not being cooked. `failed` is a value dispatch_status has
  // carried unused since the schema was written; this is what it is for.
  if (next >= config.maxAttempts) return { kind: 'failed', attempts: next, error }

  return { kind: 'retry', attempts: next, delayMs: backoffMs(next, config, random), error }
}

/**
 * Postgres truncates nothing for us and a stack trace from a fetch failure can
 * run to kilobytes. `last_error` exists to be read by a human in a hurry.
 */
export const summarise = (err, limit = 500) =>
  String(err?.message ?? err ?? 'unknown error').replace(/\s+/g, ' ').trim().slice(0, limit)
