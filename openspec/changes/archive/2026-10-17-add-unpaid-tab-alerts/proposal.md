# Proposal

## Why

Diners can now run a tab and pay at the end, so a table can eat and leave without paying. Software
cannot stop someone walking out, but staff can be told in time: who at an open table still owes,
how much, and for how long. A person who has owed for a long time is the one to go and talk to.

## What Changes

- **"Mesas abiertas" shows the risk per person:** next to each diner's unpaid part, how long it has
  been unpaid ("Ana · $30.000 · hace 1 h 20 min"), counted from when the oldest of their unpaid
  dishes went to the kitchen. Past the alert threshold the line is highlighted.
- **A long-unpaid tab raises an alert** in "Mesas que necesitan a alguien": the table, each person
  over the threshold, their unpaid amount and how long. Staff can mark it *Visto*; a new person
  crossing the threshold at the same table shows it again. It clears by itself when those people
  pay (or the table is written off or closed). The table's state does not change: it is a warning,
  not a block.
- **Threshold:** 90 minutes by default, set per deployment with `KDS_UNPAID_MINUTES` (as
  `KDS_STALL_MINUTES` already is). Not per venue yet.
- Two `staff-alerts` rules change: alerts may now list a table that is not in
  `requires_staff_attention`, and this alert shows each listed person's unpaid amount (the same
  amounts "Mesas abiertas" already shows).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `staff-alerts`: a new reason, *cuenta sin pagar hace rato*, for open sessions; listing and
  payment-detail rules widened for it.
- `staff-actions`: open tables show, per person, how long their part has been unpaid.

## Impact

- **Database:** one migration: `tab_summary` participants gain `unpaid_since`; `staff_alerts` takes
  the unpaid threshold and lists sessions with a long-unpaid person, with a per-person reason key so
  acknowledgement works as today.
- **Code:** `src/kds/app.mjs`, `src/kds/server.mjs` (`KDS_UNPAID_MINUTES`), `public/kds/kds.js` +
  `kds.css`.
- **Tests:** SQL (threshold, per person, clears on payment, ack and re-alert), KDS state, e2e.
- **Docs:** README, `docs/estado-actual.md`, `.env.example`.
- **Non-goals:** collecting cash for one person before the bill (still needs the bill); a per-venue
  threshold; notifying the diner.
- **No new dependencies.** No change to payments, rounds, dispatch or any invariant.
