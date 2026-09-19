// Turning a live reservation into something the diner can actually pay.
//
// The missing link. reserve_contribution mints a psp_reference and holds the
// shares; confirm_webhook settles whatever comes back against that reference.
// Between those two there was nothing, so the reference was orphaned and no money
// could ever move.

import { buildCheckoutUrl } from './checkout.mjs'

/**
 * Reads the reservation and returns a checkout link for exactly what it holds.
 *
 * Returns { status } rather than throwing on a refused intent, matching the
 * reservation RPCs: a lapsed hold is an ordinary outcome the UI has to render,
 * not an error.
 */
export async function createPaymentIntent(pool, { reservationId, config }) {
  const { rows } = await pool.query(
    `select r.id,
            r.psp_reference,
            r.order_amount,
            r.tip_amount,
            r.status::text as status,
            r.expires_at,
            r.expires_at > now() as still_live,
            s.currency
       from contribution_reservations r
       join rounds rd on rd.id = r.round_id
       join sessions se on se.id = rd.session_id
       join venues s on s.id = se.venue_id
      where r.id = $1`,
    [reservationId]
  )

  if (rows.length === 0) {
    return { status: 'rejected', reason: 'unknown_reservation' }
  }

  const reservation = rows[0]

  // Only a hold that is still active and still inside its TTL can be paid.
  // Handing out a checkout for a settled or lapsed reservation is how one share
  // gets paid for twice — the money would arrive, find its shares gone, and land
  // as table credit for a human to untangle.
  if (reservation.status !== 'active' || !reservation.still_live) {
    return {
      status: 'rejected',
      reason: 'reservation_not_payable',
      reservation_status: reservation.status,
      expires_at: reservation.expires_at,
    }
  }

  // The ledger keeps order and tip apart (D10) because only the order half can
  // complete a round. Wompi charges one number.
  const pesos = Number(reservation.order_amount) + Number(reservation.tip_amount)
  const amountInCents = pesos * 100

  const checkoutUrl = buildCheckoutUrl({
    // The reservation's own reference, never a fresh one. Minting a new reference
    // here is precisely how a real payment comes back unplaceable.
    reference: reservation.psp_reference,
    amountInCents,
    currency: reservation.currency,
    expiresAt: reservation.expires_at,
    ...config,
  })

  return {
    status: 'created',
    reservation_id: reservation.id,
    reference: reservation.psp_reference,
    amount_in_cents: amountInCents,
    order_amount: Number(reservation.order_amount),
    tip_amount: Number(reservation.tip_amount),
    expires_at: reservation.expires_at,
    checkout_url: checkoutUrl,
  }
}
