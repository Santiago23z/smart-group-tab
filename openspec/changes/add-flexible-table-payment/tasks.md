# Tasks

## 1. Database

- [ ] 1.1 Migration (D1, D2, D4): drop `switch_to_tab`; add `release_round_to_tab(round)` and `set_table_payment(session, participant, mode)`; `reserve_tab` accepts `my_items` before the bill on `open_tab` sessions. Grants as the other diner calls. Verify: test DB migrates, `npm run verify:schema` passes.
- [ ] 1.2 SQL tests, changing mode: to a tab and back, each with the draft round following; round 1 unpaid on a tab stays on the tab after switching back; refusals `bill_requested`, `session_closed`, `hybrid_table`, `round_needs_staff`, `someone_paying` (a live round hold and a live tab hold), `invalid_mode`, stranger; same mode → `unchanged`. Verify: `npm test` green; the `someone_paying` test fails if that check is removed.
- [ ] 1.3 SQL tests, the switched round: half paid then switched → dispatched once, paid part stays paid, tab holds the rest; two concurrent switches → one dispatch per channel (`raceReservations`-style parallel calls); a reservation that lapsed before the switch, approved afterwards, is placed on its still-unpaid shares or credited and flagged — never paid twice; `npm run audit:test` invariants hold. Verify: `npm test` and `npm run audit:test` green.
- [ ] 1.4 SQL tests, early tab payment: `my_items` before the bill on `open_tab` pays only the diner's shares, does not ask for the bill, the table can still add and close rounds; `remaining` before the bill → `bill_not_requested`; `pay_before_order` session unchanged. Verify: `npm test` green.

## 2. API

- [ ] 2.1 `src/api/server.mjs`: `POST /api/table-payment {session_id, participant_id, mode}` replacing `/api/switch-to-tab`. Verify: `tests/api-bill.test.mjs` updated (switch both ways, a refusal) and green.

## 3. Diner screen

- [ ] 3.1 `public/app.js` + `index.html` + `style.css` (D5): two-way switch in the Cuenta tab; "Seguir pidiendo y pagar todo al final" in the pay sheet; tab bar "Pagar lo mío" before the bill, cash options hidden there. Verify: e2e below and screenshots.
- [ ] 3.2 e2e: pay sheet → "Seguir pidiendo y pagar todo al final" → round in the kitchen, table on a tab; switch back → next round asks for payment; on a tab, Carla pays her part before the bill and Ana keeps ordering; update the existing switch test to the new route. Verify: `npm run test:e2e` green.

## 4. Docs and full run

- [ ] 4.1 README, `docs/estado-actual.md`, `CLAUDE.md` §5 (both directions, from the pay sheet, early tab payment). Verify: read through.
- [ ] 4.2 `npm run test:all` green from a shell without `.env`; demo migrated, web restarted, checked through the tunnel with two phones. Verify: output and screenshots.
