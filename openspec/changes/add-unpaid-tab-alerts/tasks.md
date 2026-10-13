# Tasks

## 1. Database

- [ ] 1.1 Migration (D1–D4): `tab_summary` participants gain `unpaid_since`; `staff_unpaid_reasons(session, threshold)`; `staff_alerts(stall, unpaid default 90 min)` and `acknowledge_alert(session, unpaid default 90 min)` recreated. Grants as before. Verify: test DB migrates, `npm run verify:schema` passes.
- [ ] 1.2 SQL tests: Ana's round dispatched 2 h ago (backdate `dispatched_at`) unpaid → listed with her nickname, amount and since, session stays `open`; Beto at 10 min not named; Ana pays → reason gone and table unlisted; a healthy open table not listed; ack covers it, Beto crossing later re-shows it; a flagged table whose only flagging reason is resolved goes back to `open` though Ana still owes, and stays listed for the unpaid tab only. Verify: `npm test` green; the last test fails if the unpaid reason is merged into `staff_alert_reasons`.

## 2. Kitchen server

- [ ] 2.1 `src/kds/server.mjs` + `app.mjs` (D5): `KDS_UNPAID_MINUTES` (default 90) to `staff_alerts` and the ack; `unpaid_minutes` in the state. Verify: `tests/kds.test.mjs` asserts the reason in the state with a short threshold, and `unpaid_since` in open tables.

## 3. Kitchen screen

- [ ] 3.1 `public/kds/kds.js` + `kds.css` (D5): the alert line per person; "hace …" per person in "Mesas abiertas", ticking each second, highlighted past the threshold. Verify: e2e below and a screenshot.
- [ ] 3.2 e2e (`tests/e2e/kds.spec.mjs`): a tab table whose round was dispatched long ago (backdated) shows in the alerts with the person and amount, and in "Mesas abiertas" highlighted; *Visto* marks it. Verify: `npm run test:e2e` green.

## 4. Docs and full run

- [ ] 4.1 README, `docs/estado-actual.md`, `.env.example` (`KDS_UNPAID_MINUTES`). Verify: read through.
- [ ] 4.2 `npm run test:all` green from a shell without `.env`; demo migrated, kitchen restarted, checked through the tunnel. Verify: output and a screenshot.
