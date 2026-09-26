# Proposal

## Why

Paid rounds reach `dispatches` and the worker delivers them, but nothing is on the other end:
`npm run worker` has no destination, and nobody at the venue sees the orders or the tables in
`requires_staff_attention`. The MVP demo ends at "KDS dispatch", so the kitchen screen is the
missing last step, and it is the only staff surface the MVP has.

## What Changes

- New KDS server (`npm run kds`) that is the worker's destination for both channels:
  - receives tickets on the `kds` channel, stores them once per round (a repeat delivery shows one
    order), and shows them on a kitchen web screen;
  - accepts the `print` channel and acknowledges it (stand-in for a printer that does not exist),
    so both channels reach a terminal state.
- Kitchen screen: live list of received tickets (table, round number, items, who ordered, time
  waiting). Staff can mark a ticket done; done tickets leave the active list.
- Staff alerts panel on the same screen, **read-only**: tables in `requires_staff_attention`
  with the reason (money that could not be placed, failed delivery, stalled collection), plus a
  warning when dispatches have been pending too long (worker not running). Staff can acknowledge
  an alert; acknowledging does not resolve it or change the session.
- The worker authenticates to the KDS with a shared token, and the KDS rejects unauthenticated
  tickets. Without it, anyone on the venue network could put unpaid food on the kitchen screen.
- The kitchen screen itself requires a staff token.

Out of scope: staff actions D2/D17 (force dispatch, release reservations, cancel round, record
refund), resolving alerts, printers, menu management.

## Capabilities

### New Capabilities
- `kitchen-display`: receiving kitchen tickets from the dispatch worker, de-duplicating them,
  showing them to the kitchen, and marking them done.
- `staff-alerts`: surfacing tables and conditions that need a human, read-only, with
  acknowledgement.

### Modified Capabilities
- `dispatch-delivery`: deliveries carry a credential the receiver verifies; a delivery the
  receiver refuses as unauthenticated is a failed attempt like any other.

## Impact

- New: `src/kds/` (server + pure handlers), `public/kds/` (screen), a migration adding
  `kitchen_tickets` and `staff_alert_acks`, `tests/kds*.test.mjs`, a Playwright spec.
- Changed: `src/worker/deliver.mjs` and `src/worker/server.mjs` (send the token, require it at
  startup), `package.json` (`kds` script), `.env.example`, README.
- No new dependencies.
