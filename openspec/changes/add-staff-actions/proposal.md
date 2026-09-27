# Proposal

## Why

The kitchen screen detects every incident that needs a human — money credited instead of
applied, an order that never reached the kitchen, a stalled collection — but staff can only
mark it "seen". Nothing resolves it, so a flagged table stays flagged forever and the money
behind it is never accounted for. The staff actions were decided early (D2, D17) and never
built; the first live sandbox test left Mesa 12 in exactly that state.

## What Changes

- Staff can act from the kitchen screen, behind the existing staff token:
  1. **Record a refund** of money that was credited to a table (late or duplicate payment,
     amount mismatch), and later mark it completed or rejected. The money is returned by hand;
     the system only records it. Recording it takes the amount out of the table's prepaid
     balance so it cannot also be spent; a rejection puts it back.
  2. **Cancel a round** nobody has paid for (`locked_for_payment` or
     `requires_staff_attention`, no money applied to it). Its live reservations are released.
  3. **Release a live reservation** so its shares can be paid by someone else now instead of
     after the 5-minute hold.
  4. **Retry a failed delivery** to the kitchen: the dispatch goes back to `pending` with a
     fresh attempt budget.
  5. **Resume collection** of a round in `requires_staff_attention` (back to
     `locked_for_payment`). Not in the original list of four: without it, a round flagged after
     part of it was paid can be neither cancelled nor completed.
- The kitchen screen gains a **"Cobros abiertos"** panel: rounds in collection, their
  outstanding amount and live reservations, with the round and reservation actions.
- An alert **clears itself** when its causes are resolved, and the table leaves
  `requires_staff_attention` for `open`.
- A payment that arrives for a **cancelled** round is credited and flagged (I3), never applied
  to a round that no longer exists.
- Every staff action is written to an action log (what, on what, when).

Out of scope: writing off an unpaid table (goes with `close_session`); refunds of money that
was applied to food; staff accounts (the token is shared, so the log cannot say *who*).

## Capabilities

### New Capabilities
- `staff-actions`: the actions staff can take from the kitchen screen, who may take them, the
  "Cobros abiertos" panel, and the action log.

### Modified Capabilities
- `round-lifecycle`: `cancelled` becomes reachable by staff, with its conditions; a round in
  `requires_staff_attention` can be resumed; money arriving for a cancelled round is credited.
- `refund-registry`: refunds can be recorded, completed and rejected by staff, only against
  credited money, and they move the prepaid balance.
- `dispatch-delivery`: a `failed` dispatch can be put back to `pending` by staff.
- `payment-reconciliation`: a reservation released by staff keeps being checked until its
  checkout can no longer be paid, so a payment made during a cancel is still found.
- `staff-alerts`: a reason disappears when resolved (fully refunded money, retried delivery,
  resumed or cancelled round), and a session with no reasons left returns to `open`.

## Impact

- **DB**: one migration — action RPCs (`SECURITY DEFINER`, service-role only), a
  `staff_action_log` table, `confirm_webhook` handling for cancelled rounds, and updated alert
  derivation.
- **Code**: `src/kds/app.mjs` new `POST /kds/api/...` routes; `public/kds/` new panel, buttons
  and confirmation dialogs.
- **Specs**: 1 new, 5 modified. No new dependencies.
