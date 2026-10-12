# Tasks

## 1. Database

- [ ] 1.1 Migration `20261012000100_kitchen_payment_view.sql`: `round_payment_state(round_id)` (D1) and `staff_takings_today()` (D2), execute revoked from `public, anon, authenticated` like the other `staff_*` reads. Verify: `npm run db:migrate` on the test DB and `npm run verify:schema` pass.
- [ ] 1.2 SQL tests for `round_payment_state`: open-tab round unpaid → `unpaid`; one of two diners paid → `unpaid`; all paid (Wompi and cash) → `paid`; `pay_before_order` round at dispatch → `paid`; hybrid round paid from balance → `paid`; written-off tab → `written_off`. Verify: `npm test` green, and each test fails if its branch of the function is removed.
- [ ] 1.3 SQL tests for `staff_takings_today`: zero day; Wompi with tip + cash + card terminal adds up and splits as the spec's "Three ways to pay"; a contribution at 23:50 yesterday Bogotá time is excluded; credited (`applied_to_prepaid_balance`) money counts; a completed refund shows in `refunded` and leaves `total` alone; a write-off changes nothing. Verify: `npm test` green.

## 2. Kitchen server

- [ ] 2.1 `src/kds/app.mjs`: add `'payment', round_payment_state(k.round_id)` to `ACTIVE_TICKETS`, and `takings` from `staff_takings_today()` to the state response. Verify: `tests/kds.test.mjs` asserts both fields, that a ticket still carries no amount field, and that the state route without the staff token returns 401 and no takings.

## 3. Kitchen screen

- [ ] 3.1 `public/kds/kds.js` + `kds.css`: ticket badge (*sin pagar* / *pagado · por llevar* / *pérdida asumida*, D3 colours); "Hoy $X" button in the top bar opening a breakdown dialog (Wompi, efectivo, datáfono, propinas, devuelto hoy). Verify: e2e below, and a screenshot of the demo kitchen.
- [ ] 3.2 e2e (`tests/e2e/kds.spec.mjs`): an open-tab round shows *sin pagar*, the diner pays, and the same ticket turns *pagado · por llevar* without a reload; the ticket still contains no `$`; "Hoy" shows a total that grows by the payment, and the dialog shows the split. Verify: `npm run test:e2e` green; the badge assertion fails with the badge removed.

## 4. Docs and full run

- [ ] 4.1 README (kitchen section) and `docs/estado-actual.md` (kitchen step, history row "12 oct"). Verify: read through.
- [ ] 4.2 `npm run test:all` green; demo DB migrated, kitchen restarted, checked live through the tunnel. Verify: command output and a screenshot.
