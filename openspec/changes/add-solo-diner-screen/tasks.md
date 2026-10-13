# Tasks

## 1. Diner screen

- [ ] 1.1 `public/app.js`: with one participant, no `data-share` button on cart rows, and `renderRoundActions` shows one button (`data-close="as_ordered"`) reading "Pedir y pagar" (`pay_before_order`) or "Enviar a la cocina" (`open_tab`); with two or more, today's buttons. The decision is part of the painted markup, so a join repaints it. Verify: e2e below.
- [ ] 1.2 e2e (`tests/e2e/diner.spec.mjs`): alone → no "Compartir", one close button with the right words on a pay-each-round table and on a tab table; a second diner joins → both phones show "Compartir" and both close buttons without reload. Update existing e2e that close a round alone through `data-close="equal"`, if any. Verify: `npm run test:e2e` green; the "alone" test fails with the change reverted.

## 2. Docs and full run

- [ ] 2.1 `docs/estado-actual.md`: the diner steps mention the single button when alone; history row. Verify: read through.
- [ ] 2.2 `npm run test:all` green (from a shell without `.env`); checked on the demo through the tunnel with one phone, then a second. Verify: output and a screenshot.
