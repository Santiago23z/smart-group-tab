# Tasks

## 1. Diner screen

- [ ] 1.1 `public/app.js` + `style.css`: menu row marker "En el pedido: N · nicknames" from the draft round; stepper "− N +" when the diner has units of that dish ("+" = add one; "−" = void the diner's most recently added unit of that dish); include the draft round's items in the menu redraw key, and keep photo `<img>` elements across redraws (update the rows' marker and stepper in place, not the whole list). Verify: e2e below, including the existing photo re-download test.
- [ ] 1.2 e2e: two phones, Beto adds → Ana's menu shows the mark without reload; Ana "+" twice → stepper 2, round has two units; "−" → 1; with Ana 1 and Beto 1, Ana "−" twice → Beto's unit stays, Ana's button is "+"; closing the round clears the mark. Verify: `npm run test:e2e` green; the "not someone else's" test fails if "−" may void any unit.

## 2. Kitchen

- [ ] 2.1 `src/kds/app.mjs`: `ACTIVE_TICKETS` groups items by name and ordered_by, summing quantity, ordered by first appearance. Verify: `tests/kds.test.mjs` case with two units by one diner and one by another.

## 3. Docs and full run

- [ ] 3.1 `docs/estado-actual.md`: the menu mark, the stepper, grouped tickets; history row. Verify: read through.
- [ ] 3.2 `npm run test:all` green from a shell without `.env` (fresh test DB if it has bloated); checked on the demo through the tunnel with two phones. Verify: output and screenshots.
