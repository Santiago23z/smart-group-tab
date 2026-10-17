# Tasks

## 1. State

- [x] 1.1 `src/api/server.mjs`: `my_payments: { count, last_amount }` in `/api/state` for the requesting participant (count of `contributions` rows; `order_amount + tip_amount` of the newest). Verify: `tests/` API case — zero before paying; after a simulated payment count 1 and the paid amount; another diner's count unchanged.

## 2. Diner celebration

- [x] 2.1 `public/index.html` + `public/style.css`: the `#paid` overlay (check SVG, "¡Pagado!", amount), check drawing in and card scaling from 0.96, closes after ~2.6 s or on tap; reduced-motion variant without movement. Verify: screenshot on iPhone size, normal and reduced motion.
- [x] 2.2 `public/app.js`: per-participant stored count in `localStorage`; first state stores without celebrating, a higher count celebrates with `last_amount` and vibrates where supported; Wompi `approved` return and the simulated "Pagado" toast no longer show their own message; `credited` keeps its message and skips that celebration. Verify: e2e below.
- [x] 2.3 e2e (`tests/e2e/diner.spec.mjs`): Ana pays (simulated) → her phone shows "¡Pagado!" with the amount, Beto's does not; Ana reloads → no celebration; staff register a cash payment for Beto → Beto's phone celebrates. Verify: `npm run test:e2e` green; the "only once" test fails if the stored count is not saved.

## 3. Kitchen sound

- [x] 3.1 `public/kds/index.html` + `kds.css` + `kds.js`: sound control in the top bar (off until a gesture / on / muted, mute remembered in `localStorage`); Web Audio chime unlocked on the first pointer or key event; after priming, one chime per render that adds a never-seen ticket; each chime increments `document.body.dataset.chimes`. Verify: e2e below.
- [x] 3.2 e2e (`tests/e2e/kds.spec.mjs`): tickets present on load → 0 chimes; a new round dispatched → 1 chime; the same ticket on following polls → still 1; muted → a new ticket adds none and mute survives a reload. Verify: `npm run test:e2e` green.

## 4. Docs and full run

- [x] 4.1 `docs/estado-actual.md`: the celebration, the kitchen sound and how to turn it on; history row. Verify: read through.
- [ ] 4.2 `npm run test:all` green from a shell without `.env`; tried on the demo through the tunnel with two phones and the kitchen with sound. Verify: output and screenshots.
