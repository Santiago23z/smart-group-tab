# Tasks

## 1. Data

- [x] 1.1 Migration `supabase/migrations/20261003000100_cash_requests.sql`: table, `cash_request_target` (amount and what it covers), `request_cash_payment`, `cancel_cash_request`, `staff_dismiss_cash_request`, `staff_cash_requests`; tests in `tests/cash-requests.test.mjs`: request for mine and rest (round and tab), one open per diner (new replaces old), cancel, dismiss logged, refused when nothing unpaid, amount follows payments and the request disappears when paid by Wompi or by cash.

## 2. Servers and screens

- [x] 2.1 Diner API `POST /api/cash-request`, `POST /api/cash-request/cancel`, open request in `/api/state`; KDS `cash_requests` in state and `POST /kds/api/cash-requests/:id/dismiss`; tests in `tests/kds.test.mjs` and an API test.
- [x] 2.2 Diner pay sheet buttons and waiting bar with Cancelar; KDS "Quieren pagar" section with prefilled "Cobrar en caja" and "Descartar"; Playwright: a diner asks for cash, the kitchen sees it, collects it, and both screens update.

## 3. Docs and verification

- [x] 3.1 README and `docs/estado-actual.md`; `npm run test:all` green; migrate the demo database.
