# Proposal

## Why

User feedback on the menu:

- Diners at a table cannot see, on the menu, what the table is ordering. Someone about to order a
  bottle of rum does not know a friend already put one in.
- Ordering two of something works (tap "+" twice) but the screen never says how many you have, and
  there is no way to take one back from the menu. The kitchen then gets two lines "1× Botella de
  ron" instead of "2×".

## What Changes

- **The menu shows what the table is ordering.** A dish that is in the round being built shows,
  under its name, how many and who: "En el pedido: 2 · Ana, Beto". It updates as anyone adds or
  removes, on every phone. Dishes already sent to the kitchen are not marked.
- **Quantities on the menu.** Once you have a dish in the round, its "+" becomes a stepper
  "− 2 +": "+" adds one more, "−" takes your most recent one back. Each unit stays its own item,
  so one of two bottles can still be shared or removed on its own in the Cuenta tab.
- **The kitchen ticket groups identical dishes** ordered by the same person in a round: "2×
  Botella de ron · Ana", instead of two "1×" lines.
- No change to how a round is priced, split, paid or dispatched.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `diner-screen`: the menu marks what the table is ordering, and offers a stepper for your own units.
- `kitchen-display`: identical dishes for the same diner in a round are shown as one line.

## Impact

- **Code:** `public/app.js` + `style.css` (menu marker and stepper; the menu redraw key gains the
  round's items so the marker updates without re-decoding photos), `src/kds/app.mjs` (ticket item
  projection grouped).
- **Tests:** e2e (marker on two phones; stepper adds and removes; the stepper's "−" removes only
  your own unit), KDS (grouped ticket), and the existing "photos not re-downloaded across polls"
  test must still pass.
- **Docs:** `docs/estado-actual.md`.
- **No new dependencies.** No database change.
