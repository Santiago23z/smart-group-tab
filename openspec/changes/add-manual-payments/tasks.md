# Tasks

## 1. Database

- [x] 1.1 Migration `supabase/migrations/20260930000100_manual_payments.sql`: `manual_payments` (append-only, RLS on, grants revoked), `session_caja`, `staff_record_manual_payment(scope, target_id, participant_id|null, method, reference, tip)`; verify `npm run verify:schema` and the existing suite still green.
- [x] 1.2 Tests in `tests/manual-payments.test.mjs`: one diner's part of a round in cash; the rest on the card terminal releases the round to the kitchen exactly once; a tab paid in cash closes the table; shares held by a live reservation are skipped, and a part fully held is refused with `nothing_available`; invalid method, unknown target, bill not requested, round not collecting are refused and record nothing; the record carries method, reference, amount, tip and participant (Caja for the rest); one staff log entry per payment.
- [x] 1.3 Audit: every `manual` event has its `manual_payments` record and its contribution; verify `npm run audit:test` green.

## 2. Kitchen screen

- [x] 2.1 KDS route `POST /kds/api/manual-payments` and per-person unpaid parts in the state for open collections; verify in `tests/kds.test.mjs` (staff token only, refusals 409, unknown 404).
- [x] 2.2 "Cobrar en caja" dialog on open collections and open tables; verify with Playwright: record a cash payment for one person, dismissing sends nothing, and the rest on the card terminal closes a tab.

## 3. Docs and verification

- [x] 3.1 README and `docs/estado-actual.md` (cash done; limitation: no undo).
- [x] 3.2 `npm run test:all` green; migrate the demo database and `npm run audit` green.
- [ ] 3.3 Live check on the demo (automated): an open-tab table where one diner pays in Wompi and the rest is recorded as cash from the kitchen screen; the table closes.
