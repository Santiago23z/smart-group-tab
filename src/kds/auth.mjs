// Smart Group Tab — the KDS's two credentials.
//
// DISPATCH_TOKEN proves a ticket came from the worker. KDS_STAFF_TOKEN proves a
// screen belongs to staff. Different jobs, named apart, like the two Wompi
// secrets.

import { createHash, timingSafeEqual } from 'node:crypto'

// Hashing first gives both sides the same length, so timingSafeEqual never
// throws and the comparison leaks neither the token nor its length.
const digest = (s) => createHash('sha256').update(String(s)).digest()

/** True only for `Authorization: Bearer <expected>`. */
export function hasBearer(headers, expected) {
  if (!expected) return false
  const match = /^Bearer (.+)$/.exec(headers?.authorization ?? '')
  if (!match) return false
  return timingSafeEqual(digest(match[1]), digest(expected))
}
