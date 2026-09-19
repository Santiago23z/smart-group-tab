// The one place where something outside our control can move the ledger.

import { parseTransactionEvent } from './events.mjs'
import { verifySignature } from './signature.mjs'

/**
 * Processes one Wompi delivery.
 *
 * Returns { httpStatus, result } rather than throwing, because what we answer
 * Wompi decides whether they retry. A 500 means "try again"; for anything we have
 * durably recorded we want 200 even when nothing changed, or their retries queue
 * up behind an event we already handled.
 */
export async function handleWompiWebhook({ body, secret, pool }) {
  // Fail closed. A deployment missing its secret must refuse to run rather than
  // wave everything through, and that is a crash, not a 4xx.
  if (!secret) {
    throw new Error('WOMPI_EVENTS_SECRET is not set; refusing to process webhooks')
  }

  // Structure is checked before the signature on purpose. Parsing touches
  // nothing and cannot be exploited, and it lets a genuinely malformed body come
  // back as 400 instead of a misleading 401 that would send someone hunting for
  // a key rotation problem that does not exist.
  let event
  try {
    event = parseTransactionEvent(body)
  } catch (err) {
    return { httpStatus: 400, result: { status: 'malformed', reason: err.message } }
  }

  if (!verifySignature(body, secret)) {
    return { httpStatus: 401, result: { status: 'invalid_signature' } }
  }

  if (event.outcome === 'pending') {
    return { httpStatus: 200, result: { status: 'ignored', reason: 'transaction_pending' } }
  }

  // Everything past this point is the database's problem, and confirm_webhook is
  // idempotent by construction: the full body is stored so an unexplained payment
  // can still be reconstructed months later.
  const { rows } = await pool.query(
    `select confirm_webhook($1, $2, $3, $4, $5::bigint, $6::jsonb, $7) as r`,
    ['wompi', event.eventId, event.reference, event.outcome, event.amount, JSON.stringify(body), true]
  )

  return { httpStatus: 200, result: rows[0].r }
}
