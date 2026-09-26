# Tasks

## 1. Database

- [x] 1.1 Add migration `supabase/migrations/20260926000100_kitchen_display.sql` with `kitchen_tickets` and `staff_alert_acks`; verify with `npm run db:reset` and `npm run verify:schema`
- [x] 1.2 Add `staff_alerts(p_stall interval)` to the same migration (reasons, reason keys, ack state, stall warning); verify with tests in `tests/staff-alerts.test.mjs` covering: credited money, failed dispatch, stalled round, unknown reason, healthy session not listed, backoff row not counted, stale due row counted
- [x] 1.3 Add acknowledge SQL (`acknowledge_alert(session_id)` storing current reason keys); verify tests: ack keeps session `requires_staff_attention`, a new failed dispatch un-acknowledges

## 2. Worker credential

- [x] 2.1 `deliver()` sends `authorization: Bearer <token>`, `drain()` passes `token`; verify a test in `tests/worker-decisions.test.mjs` asserts the header
- [x] 2.2 `src/worker/server.mjs` refuses to start without `DISPATCH_TOKEN`; verify by running it without the variable and seeing the exit
- [x] 2.3 Test in `tests/dispatch-worker.test.mjs`: a receiver answering 401 leaves the row `pending`, attempts grown, 401 in `last_error`

## 3. KDS ingest

- [x] 3.1 `src/kds/auth.mjs` (constant-time bearer check) and `src/kds/ingest.mjs` (validate ticket + headers, upsert for `kds`, ack for `print`); verify unit tests in `tests/kds.test.mjs` for forged token, malformed body, missing headers
- [x] 3.2 `src/kds/server.mjs` + `npm run kds`: `/ingest/kds`, `/ingest/print`, `/kds/api/state`, `/kds/api/tickets/:round/done`, `/kds/api/alerts/:session/ack`; refuses to start without `DISPATCH_TOKEN` or `KDS_STAFF_TOKEN`; verify by starting it with and without them
- [x] 3.3 End-to-end test (real worker `drain()` → real KDS server): a released round appears once in `kitchen_tickets`; a repeat delivery bumps `receive_count` and leaves one ticket; a done ticket is not reopened; both dispatch rows end `delivered`
- [x] 3.4 Test that `/kds/api/*` without the staff token returns 401 and no data, and that state contains no money fields

## 4. Kitchen screen

- [x] 4.1 `public/kds/index.html`, `kds.js`, `kds.css`: token from `#token=` to `localStorage`, poll every 3s + on focus, active tickets oldest-first with timer, "listo" button, alerts panel with reasons, ack button and stall warning; verify manually with `npm run web` + `npm run worker` + `npm run kds`
- [x] 4.2 Playwright spec `tests/e2e/kds.spec.mjs` (second webServer, desktop viewport): a paid round appears on the screen without reload, "listo" removes it, a table in `requires_staff_attention` shows its reason; verify `npm run test:e2e` passes

## 5. Docs and full check

- [x] 5.1 Update `.env.example` (`DISPATCH_TOKEN`, `KDS_STAFF_TOKEN`, `KDS_STALL_MINUTES`) and README (how to run the three processes, phase 5 status); verify by following the README from a clean shell
- [x] 5.2 Run `npm run test:all` and confirm everything passes
