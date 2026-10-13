# Proposal

## Why

Feedback from a real user: someone alone at a table sees buttons that only make sense for a group
— *Compartir* on every dish, and two ways to close a round (*cada quien lo suyo* / *partes
iguales*) that give the same result when there is one person. It reads as a group app forced on a
single diner, and every extra choice is one more thing to understand before ordering.

## What Changes

- While a diner is the only person at the table, the cart shows no *Compartir* button, and closing
  a round is one button whose words say what happens next: **Pedir y pagar** when the table pays
  each round, **Enviar a la cocina** when it runs a tab.
- As soon as a second person joins, the screen shows the group buttons again, on every phone at the
  table, on the next refresh. Nothing about the round changes when someone joins.
- Nothing changes in the database or the API: one person closing "as ordered" and "equally" already
  charge the same.

## Capabilities

### New Capabilities

- `diner-screen`: what the diner's phone shows, starting with the solo-table simplification. No
  spec described the diner's screen until now.

### Modified Capabilities

_None._

## Impact

- **Code:** `public/app.js` (cart rows and round actions), `public/style.css` if needed.
- **Tests:** e2e in `tests/e2e/diner.spec.mjs` (alone: no share, one button; a second diner joins:
  both phones show the group buttons).
- **Docs:** `docs/estado-actual.md`.
- **No new dependencies.** No change to payments, rounds or any invariant.
