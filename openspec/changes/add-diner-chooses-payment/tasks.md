# Tasks

## 1. Remove the kitchen's mode setting

- [ ] 1.1 `git revert e3bf84a 1bd3235` (D5) and delete `openspec/changes/add-service-mode-setting`; the test DB is rebuilt so `staff_set_service_mode` is gone. Verify: `npm run test:all` green on the reverted tree before anything else.

## 2. Database

- [ ] 2.1 Migration: `open_or_join_session(qr, nickname, mode default null)` (D1), `table_status(qr)` (D2), `switch_to_tab(session, participant)` (D3), with grants matching the other diner calls. Verify: test DB migrates, `npm run verify:schema` passes.
- [ ] 2.2 SQL tests: first diner chooses `open_tab` at a `pay_before_order` venue → session `open_tab`, round dispatched unpaid; no choice → venue mode; `hybrid`/junk → `invalid_mode`, no session; a later joiner's choice is ignored and `chose: false`; `table_status` free / open with mode / unknown, and no nickname, amount or session id in it. Verify: `npm test` green.
- [ ] 2.3 SQL tests for the switch: round 1 paid, switch, round 2 dispatched unpaid, tab holds round 2 only; draft round with a dish follows the switch; refused while a round is `locked_for_payment`, after the bill, on an `open_tab` session, on a closed session, for a participant of another session. Verify: `npm test` green; the `round_in_collection` test fails if that check is removed.

## 3. API

- [ ] 3.1 `src/api/server.mjs`: `/api/join` passes `mode`; `GET /api/table?qr=`; `POST /api/switch-to-tab`. Verify: `tests/api-*.test.mjs` cases for each, including a refused switch.

## 4. Diner screen

- [ ] 4.1 `public/index.html` + `app.js` + `style.css` (D4): choice cards on a free table's join screen (Entrar disabled until chosen), the open table's line, the how-the-table-pays line in the header, the "Pasar a pagar al final" button with its inline confirmation. Verify: e2e below and screenshots.
- [ ] 4.2 e2e (`tests/e2e/diner.spec.mjs`): alone, choose "Abrir cuenta" → round goes to the kitchen with no payment, ask for the bill, pay; on a pay-each-round table pay round 1, switch, order round 2, it goes unpaid, the bill holds round 2 only; a second diner at an open table sees the line and no choice. Update `joinAs` and any test that relied on the venue's mode. Verify: `npm run test:e2e` green.

## 5. Docs and full run

- [ ] 5.1 README, `docs/estado-actual.md` (the three modes: the diner chooses two of them; switching), `CLAUDE.md` §5 (mode chosen by the first diner, one forward switch). Verify: read through.
- [ ] 5.2 `npm run test:all` green from a shell without `.env`; demo migrated, web restarted, checked through the tunnel with two phones. Verify: output and screenshots.
