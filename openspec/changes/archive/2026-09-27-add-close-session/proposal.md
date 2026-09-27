# Proposal

## Why

A table can open but never close. In `open_tab` every round goes to the kitchen unpaid and there
is **no way to pay it afterwards**: reservations only accept rounds still in collection, so an
open tab has no payment path at all. Nothing moves a session to `closed`, so the table can never
seat a new party either. The strategy question that blocked this (§15, who covers an unpaid open
tab) is now answered: the rest of the table absorbs it, and if the whole table leaves, the venue
writes it off from the kitchen screen.

## What Changes

- **Asking for the bill.** Any diner ("Pedir la cuenta"), or staff from the kitchen screen, can
  put a session into settlement. From then on nothing new can be ordered.
- **The tab** is every share of a round that went to the kitchen without being paid (all
  `open_tab` rounds) and is not yet paid or written off.
- **One payment for the whole tab.** In settlement a diner pays, in a single Wompi checkout,
  either everything they ordered across all rounds ("Pagar lo mío") or everything still unpaid at
  the table ("Cubrir el resto"). Same holds, same reservation TTL, same webhook, reconciliation
  and credit rules as a round payment.
- **Write-off.** When the whole table has left, staff write off everything still unpaid, with a
  mandatory reason. It covers the entire remaining tab — never selected items or part of an
  amount — so it cannot be used as a discount. It is recorded in the ledger and the action log.
- **Closing.** A session closes when it is in settlement, nothing is unpaid, no round is still in
  collection, and no credit or pending refund is left. It closes itself when the last payment or
  write-off makes that true; staff can also close it from the kitchen screen, which says what is
  still blocking. A closed table seats a new party.
- **Kitchen screen:** a "Mesas abiertas" panel with each open table's tab, "Pedir la cuenta",
  "Asumir pérdida" and "Cerrar mesa".
- **Two fixes this depends on:**
  - `hybrid` rounds paid from the prepaid balance are recorded as paid, or the tab would charge
    them again;
  - "the bill was asked for" is kept apart from the session's status, so a late payment that
    flags the table for staff cannot silently reopen ordering.

Out of scope: reopening a table after the bill was asked for; applying leftover credit to the
tab automatically (it is refunded with the existing refund flow); partial write-offs; cash
payments; multi-venue.

## Capabilities

### New Capabilities
- `tab-settlement`: asking for the bill, what the tab is, paying it in one payment across rounds,
  writing it off, and closing the table.

### Modified Capabilities
- `session-lifecycle`: settlement blocks ordering whatever the status says; hybrid rounds paid
  from the balance are never owed again; a session reaches `closed`.
- `staff-actions`: the "Mesas abiertas" panel and three new actions (request bill, write off,
  close table).
- `staff-alerts`: a cleared alert returns a table in settlement to settlement, not to `open`.

## Impact

- **DB**: one migration — reservations and contributions may belong to a session instead of a
  single round (`round_id` nullable, `session_id` added), `sessions.bill_requested_at`,
  `rounds.paid_from_balance`, write-off tables, settlement RPCs, `confirm_webhook` and
  `close_round` updates, and allocation-based audit checks.
- **Code**: diner API and page (bill button, tab view, tab payment); `createPaymentIntent` reads
  the session from the reservation; KDS routes and panel; `scripts/audit-invariants.mjs`.
- **Specs**: 1 new, 3 modified. No new dependencies.
