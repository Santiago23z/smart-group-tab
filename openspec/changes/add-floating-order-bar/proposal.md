# Proposal

## Why

User feedback: after adding dishes on the menu, ordering and paying means scrolling back to the
top, switching to the "Cuenta" tab, closing the round, then opening the pay sheet. The diner's goal
right after adding is "send this / pay this", and the screen makes them hunt for it.

## What Changes

- **A floating order bar on the menu.** While the table's round being built has dishes and nothing
  else occupies the bottom bar, the Carta tab shows a floating bar at the bottom: how many dishes
  and the round's total, and one button.
- **Alone at the table, the button does it all.** "Pedir y pagar" (table paying each round) closes
  the round and opens the pay sheet directly; "Enviar a la cocina" (table on a tab) closes the round
  and sends it. One tap instead of four or five.
- **With others at the table, the button is "Ver pedido"**: it switches to the Cuenta tab at the
  top, where the round is closed with its split choice — that choice applies to everyone, so it is
  not taken from a floating button.
- The bar appears and leaves with the same motion as the existing bottom bar; it never covers the
  pay bar, which keeps priority.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `diner-screen`: a floating order bar on the menu, with a one-tap close-and-pay when alone.

## Impact

- **Code:** `public/index.html`, `public/app.js`, `public/style.css`. No server or database change:
  closing a round and paying use the existing calls.
- **Tests:** e2e (alone: add → one tap → pay sheet open; on a tab: one tap → sent; with two diners:
  "Ver pedido" opens the Cuenta tab; the bar yields to the pay bar).
- **Docs:** `docs/estado-actual.md`.
- **No new dependencies.** No change to payments, rounds or any invariant.
