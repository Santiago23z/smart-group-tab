// Building a Wompi Web Checkout link.
//
// Web Checkout rather than the transactions API, deliberately. A guest who
// scanned a QR and typed a nickname has no email, no saved card and no account
// (D9), and the transactions API wants all of that plus an acceptance token and a
// per-method payload. Wompi's own screen collects whatever Nequi or PSE needs; we
// hand over a signed URL and stay out of the way.
//
// THE TWO SECRETS ARE NOT THE SAME.
//   - events secret    → verifies webhooks arriving from Wompi (signature.mjs)
//   - integrity secret → signs the charge we send to Wompi (here)
// Swapping them produces a failure that reads like a key rotation problem.

import { createHash } from 'node:crypto'

export function computeIntegritySignature({
  reference,
  amountInCents,
  currency,
  expirationTime = null,
  integritySecret,
}) {
  if (!integritySecret) {
    throw new Error('WOMPI_INTEGRITY_SECRET is not set; refusing to sign a charge')
  }

  // Lowercase hex here, unlike the uppercase event checksum. Wompi is not
  // consistent between the two and neither will accept the other's casing.
  //
  // An expiration, when sent, is signed too, between currency and secret —
  // the exact string that goes in the URL. Leaving it out is rejected at
  // checkout as "La firma es inválida".
  return createHash('sha256')
    .update(`${reference}${amountInCents}${currency}${expirationTime ?? ''}${integritySecret}`)
    .digest('hex')
}

export function buildCheckoutUrl({
  reference,
  amountInCents,
  currency = 'COP',
  expiresAt = null,
  publicKey,
  integritySecret,
  checkoutBaseUrl = 'https://checkout.wompi.co/p/',
  redirectUrl = null,
}) {
  if (!publicKey) {
    throw new Error('WOMPI_PUBLIC_KEY is not set')
  }

  // Tie the checkout's life to the hold's. A checkout that outlives its
  // reservation is a diner paying for a share somebody else has since taken —
  // recoverable (the money becomes table credit and staff are told) but it is a
  // bad minute for everyone involved, and avoidable here for free.
  const expirationTime = expiresAt ? new Date(expiresAt).toISOString() : null

  const url = new URL(checkoutBaseUrl)
  url.searchParams.set('public-key', publicKey)
  url.searchParams.set('currency', currency)
  url.searchParams.set('amount-in-cents', String(amountInCents))
  url.searchParams.set('reference', reference)
  url.searchParams.set(
    'signature:integrity',
    computeIntegritySignature({ reference, amountInCents, currency, expirationTime, integritySecret })
  )

  if (redirectUrl) {
    url.searchParams.set('redirect-url', redirectUrl)
  }

  if (expirationTime) {
    url.searchParams.set('expiration-time', expirationTime)
  }

  return url.toString()
}
