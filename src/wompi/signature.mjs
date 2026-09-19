// Wompi event signatures.
//
// Wompi signs an event by concatenating, in order: the values of the properties
// named in `signature.properties`, then the event timestamp, then the venue's
// events secret. The SHA-256 of that string, uppercase hex, is `signature.checksum`.
//
// The property list is part of what is signed only implicitly — it determines
// the concatenation order, so reordering it produces a different checksum. That
// is what stops an attacker from rearranging fields to make a different payload
// hash the same.

import { createHash, timingSafeEqual } from 'node:crypto'

/** "transaction.amount_in_cents" -> body.data.transaction.amount_in_cents */
function readSignedProperty(body, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), body?.data)
}

export function computeChecksum(body, secret) {
  const properties = body?.signature?.properties

  if (!Array.isArray(properties) || properties.length === 0) {
    throw new Error('event declares no signed properties')
  }

  const values = properties.map((path) => {
    const value = readSignedProperty(body, path)
    if (value === undefined || value === null) {
      throw new Error(`signed property ${path} is missing from the payload`)
    }
    return String(value)
  })

  return createHash('sha256')
    .update(`${values.join('')}${body.timestamp}${secret}`)
    .digest('hex')
    .toUpperCase()
}

export function verifySignature(body, secret) {
  const provided = body?.signature?.checksum
  if (typeof provided !== 'string' || provided.length === 0) {
    return false
  }

  let expected
  try {
    expected = computeChecksum(body, secret)
  } catch {
    // A payload we cannot even hash is a payload we do not believe.
    return false
  }

  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided.toUpperCase(), 'utf8')

  // timingSafeEqual throws on length mismatch, so guard first. The length itself
  // is not a secret — it is a fixed 64 hex characters.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
