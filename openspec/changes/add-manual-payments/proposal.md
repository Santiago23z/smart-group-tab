# Proposal

## Why

Money only reaches the ledger through Wompi. In a Colombian bar many people pay in cash or on the
venue's card terminal, and today the system cannot record that: a round paid in cash never goes
to the kitchen, and a tab paid in cash never closes. The only workaround — writing it off — would
record real income as a loss.

## What Changes

- Staff can declare, from the kitchen screen, **"Pago recibido"** for a diner's part or for
  everything still unpaid, of a round in collection or of a tab in settlement, choosing
  **efectivo** or **datáfono**, with an optional reference (voucher number) and tip.
- It settles through the **same path as a Wompi payment**: a reservation over exactly the free
  shares, then `confirm_webhook` with provider `manual`. Same idempotency, same share rules
  (nothing held by someone paying in Wompi right now is taken), same release to the kitchen,
  same automatic close of the table.
- Every manual payment is recorded in a new append-only `manual_payments` table (method,
  reference, amount, tip, who it was for, when) and in the staff action log.
- "Todo lo que falta" is recorded on behalf of a per-table **Caja** participant (kind `staff`),
  which never receives shares.
- The amount is never typed by staff: it is exactly what the chosen part or the rest adds up to,
  so a manual payment cannot over- or under-collect.
- The audit gains checks that every manual event has its record and its contribution.

Out of scope: undoing a manual payment declared by mistake (there is a confirmation step; a
correction would be a refund, which today only covers credited money); partial cash amounts;
mixing cash and card for one person in one action; cash drawer reconciliation.

## Capabilities

### New Capabilities
- `manual-payments`: how staff record a payment received outside Wompi, what it settles, how it
  is recorded, and what it refuses.

### Modified Capabilities
None. Settlement, release to the kitchen and closing are reused unchanged; the new capability
states that a manual payment goes through them.

## Impact

- **DB**: one migration — `manual_payments` table, a helper for the per-session Caja participant,
  `staff_record_manual_payment` RPC; audit checks.
- **Code**: KDS route `POST /kds/api/manual-payments` and state (who owes what, per round and per
  tab); KDS screen: "Cobrar en caja" on open collections and open tables, with a confirmation
  dialog. The diner app needs no change: it already shows shares as paid.
- **Specs**: 1 new. No new dependencies.
