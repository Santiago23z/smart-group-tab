// Settling what Wompi tells us when we ask, rather than when it calls.
//
// Not a second settlement path: the transaction goes through the same parser and
// the same confirm_webhook as the webhook does, so a lookup and a webhook for the
// same transaction and status carry the same event id, and whichever arrives
// second is a duplicate by construction.

import { parseTransactionEvent } from './events.mjs'

// Wompi's answer includes the diner's email, phone and national id. Settlement
// needs none of it, and a ledger that keeps it has to be protected like it.
const KEPT_FIELDS = [
  'id', 'status', 'reference', 'amount_in_cents', 'currency',
  'payment_method_type', 'created_at', 'finalized_at',
]

const trim = (transaction) =>
  Object.fromEntries(KEPT_FIELDS.filter((k) => k in transaction).map((k) => [k, transaction[k]]))

/**
 * Settles one transaction as returned by Wompi's API. Returns confirm_webhook's
 * result, or { status: 'ignored' } while the transaction is still pending.
 */
export async function reconcileTransaction(pool, transaction) {
  const event = parseTransactionEvent({ data: { transaction } })

  if (event.outcome === 'pending') {
    return { status: 'ignored', reason: 'transaction_pending' }
  }

  const payload = { source: 'wompi_api', data: { transaction: trim(transaction) } }

  // Verified: the data came from our own call to Wompi over TLS, authenticated
  // with our private key — as trustworthy as a signed event.
  const { rows } = await pool.query(
    `select confirm_webhook($1, $2, $3, $4, $5::bigint, $6::jsonb, $7) as r`,
    ['wompi', event.eventId, event.reference, event.outcome, event.amount, JSON.stringify(payload), true]
  )
  return rows[0].r
}

/**
 * One pass of the periodic check: claim the reservations due, ask Wompi about
 * each by reference, settle whatever has a final outcome.
 *
 * Claiming pushes each row's next check one interval forward before Wompi is
 * asked, so a failure here — Wompi down, a crash mid-pass — simply means the
 * row comes due again next interval. Nothing is lost by giving up early.
 */
export async function reconcileDue(pool, { api, intervalSeconds = 60, limit = 50, log = () => {} }) {
  const { rows } = await pool.query(
    `select * from claim_due_checkouts(make_interval(secs => $1), interval '24 hours', $2)`,
    [intervalSeconds, limit]
  )

  const checked = []
  for (const { reservation_id: reservationId, psp_reference: reference } of rows) {
    let outcome
    try {
      // A declined attempt can share a reference with a later approval. Order
      // does not matter: confirm_webhook still settles an approval on a hold a
      // decline just released, as long as nobody else took those shares.
      const transactions = await api.findByReference(reference)
      for (const tx of transactions) {
        const result = await reconcileTransaction(pool, tx)
        if (result.status !== 'ignored' && result.status !== 'duplicate_event') {
          log(`[reconcile] ${reference} ${tx.status}: ${result.status}`)
        }
      }
      outcome = transactions.length ? transactions.map((t) => t.status).join(',') : 'none'
    } catch (err) {
      outcome = `error: ${err.message}`
      log(`[reconcile] ${reference}: ${err.message}`)
    }
    await pool.query(`select record_checkout_check($1, $2)`, [reservationId, outcome])
    checked.push({ reservationId, reference, outcome })
  }
  return checked
}
