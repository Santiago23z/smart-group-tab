// Translating a Wompi transaction event into something the ledger accepts.

const OUTCOME_BY_STATUS = {
  APPROVED: 'approved',
  // Everything that is not an approval releases the hold. The ledger does not
  // care why a payment failed, only that the shares are free again.
  DECLINED: 'declined',
  VOIDED: 'declined',
  ERROR: 'declined',
  // Still in flight. Nobody has paid anything yet, so there is nothing to record.
  PENDING: 'pending',
}

export function parseTransactionEvent(body) {
  const tx = body?.data?.transaction

  if (!tx || typeof tx.id !== 'string' || typeof tx.status !== 'string') {
    throw new Error('not a Wompi transaction event')
  }

  const outcome = OUTCOME_BY_STATUS[tx.status]
  if (!outcome) {
    throw new Error(`unrecognised Wompi status: ${tx.status}`)
  }

  if (tx.currency && tx.currency !== 'COP') {
    throw new Error(`unsupported currency ${tx.currency}; the ledger is denominated in COP`)
  }

  // Validated like every other field. Letting it through as undefined made `pg`
  // send SQL NULL, which matched no reservation, so a real approved payment came
  // back as `unknown_reference` with a cheerful 200.
  if (typeof tx.reference !== 'string' || tx.reference.length === 0) {
    throw new Error('transaction is missing a reference')
  }

  const cents = tx.amount_in_cents

  // Strictly positive, not merely non-negative. A zero-amount approval produced a
  // contribution of 0, which fails a CHECK, which rolls back the idempotency row
  // along with everything else — leaving Wompi to retry the same failure forever
  // with nothing recorded.
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error('amount_in_cents must be a positive integer')
  }

  // Wompi speaks cents; the ledger stores COP in pesos, which is the minor unit
  // that actually circulates. A fractional peso means we and Wompi disagree about
  // what currency this is, and guessing would be worse than stopping.
  if (cents % 100 !== 0) {
    throw new Error(`${cents} cents is not a whole peso`)
  }

  return {
    // Wompi sends no separate event id. The transaction plus its state is stable
    // across retries and distinct across transitions, which is exactly what the
    // ledger's idempotency gate needs: a retried APPROVED collides, while
    // PENDING -> APPROVED does not.
    eventId: `${tx.id}:${tx.status}`,
    transactionId: tx.id,
    reference: tx.reference,
    outcome,
    amount: cents / 100,
    status: tx.status,
  }
}
