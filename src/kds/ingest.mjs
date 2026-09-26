// Smart Group Tab — checking a delivered ticket before anything is stored.
//
// Plain function, no HTTP and no database: headers and body in, a verdict out.
// The order mirrors the Wompi handler — structure before anything else — except
// that the credential comes first here: an unauthenticated caller learns nothing
// about what a valid ticket looks like.

import { hasBearer } from './auth.mjs'

export const CHANNELS = ['kds', 'print']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * @returns {{ ok: true, channel, roundId, ticket }
 *         | { ok: false, status: 400 | 401, reason }}
 */
export function checkDelivery({ channel, headers, rawBody, dispatchToken }) {
  if (!hasBearer(headers, dispatchToken)) {
    return { ok: false, status: 401, reason: 'bad_dispatch_token' }
  }
  if (!CHANNELS.includes(channel)) {
    return { ok: false, status: 400, reason: 'unknown_channel' }
  }
  if (headers['x-dispatch-channel'] !== channel) {
    return { ok: false, status: 400, reason: 'channel_mismatch' }
  }

  const roundId = headers['x-dispatch-round']
  if (!UUID.test(roundId ?? '')) {
    return { ok: false, status: 400, reason: 'missing_round' }
  }

  let ticket
  try {
    ticket = JSON.parse(rawBody)
  } catch {
    return { ok: false, status: 400, reason: 'not_json' }
  }
  if (!ticket || typeof ticket !== 'object' || !Array.isArray(ticket.items)) {
    return { ok: false, status: 400, reason: 'not_a_ticket' }
  }
  // The header is the idempotency key; a body naming another round means one
  // of the two is wrong, and storing either would be a guess.
  if (ticket.round_id !== roundId) {
    return { ok: false, status: 400, reason: 'round_mismatch' }
  }

  return { ok: true, channel, roundId, ticket }
}
