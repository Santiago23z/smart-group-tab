# Tasks

## 1. Diner screen

- [ ] 1.1 `public/index.html` + `app.js` + `style.css`: a floating order bar (`#order-bar`) shown on the Carta tab when the current round is `draft` with items and `#bar` is hidden; count and total from the round; button per the spec (alone: close as ordered, then open the pay sheet when the round is in collection; with others: switch to Cuenta and scroll to top). Same enter/exit motion as `#bar`. Verify: e2e below and a screenshot.
- [ ] 1.2 e2e (`tests/e2e/diner.spec.mjs`): alone paying each round → one tap → pay sheet open with the right amount; alone on a tab → one tap → "Pedido enviado a cocina"; two diners → "Ver pedido" → Cuenta tab visible with both close buttons; with a round in collection the order bar is hidden and `#bar` shown. Verify: `npm run test:e2e` green; the alone test fails if the button only switches tabs.

## 2. Docs and full run

- [ ] 2.1 `docs/estado-actual.md`: the floating bar in the diner steps; history row. Verify: read through.
- [ ] 2.2 `npm run test:all` green from a shell without `.env`; checked on the demo through the tunnel. Verify: output and a screenshot.
