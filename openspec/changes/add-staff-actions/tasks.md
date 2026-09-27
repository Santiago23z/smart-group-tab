# Tasks

## 1. Database

- [x] 1.1 Migration `supabase/migrations/20260928000100_staff_actions.sql`: `staff_action_log` (RLS on, grants revoked) and `staff_resolve_if_clear(session)`; verify with `npm run db:migrate` and `npm run verify:schema`.
- [x] 1.2 Factor the release-to-kitchen block of `confirm_webhook` into an internal `release_round_if_settled(round)` and add the `round_cancelled` credit branch (D5, D6); verify the whole existing suite still passes (`npm test`) plus a new test in `tests/staff-actions.test.mjs`: approval for a cancelled round → `credited`, round stays `cancelled`, no dispatch rows, session flagged.
- [x] 1.3 `staff_record_refund` and `staff_set_refund_status` (D3); verify in `tests/staff-actions.test.mjs`: pending refund lowers the balance; refused over balance, over ceiling, against applied money, with empty reason; completed keeps the balance and is final; rejected restores it; two concurrent refunds on one credit cannot both pass (race test).
- [x] 1.4 `staff_cancel_round` (D4); verify: cancels a locked round with no money and releases its live reservation; refused with applied money, for `draft`, `paid_and_dispatched`, `cancelled`; a cancel racing the final payment leaves exactly one winner (race test).
- [x] 1.5 `staff_resume_round` (D6); verify: back to `locked_for_payment` and collectable; a flagged round whose shares are all paid is released to the kitchen exactly once.
- [x] 1.6 `staff_release_reservation`; verify: live reservation → `cancelled` and its shares are reservable by someone else; refused if expired, confirmed or cancelled.
- [x] 1.7 `staff_retry_dispatch` (D7); verify: `failed` → `pending`, attempts 0, due now, and the real `drain()` then delivers it; refused for `pending` and `delivered`.
- [x] 1.8 Alert derivation (D8): update `staff_alert_reasons`; verify in `tests/staff-alerts.test.mjs`: money reason shows pending refunds and disappears on a completed full refund; collection stalled covers a flagged round with credit; after the last reason is resolved the session is `open`; with two reasons, resolving one keeps it flagged.
- [x] 1.9 Every action logs exactly once on success and never on refusal; verify in `tests/staff-actions.test.mjs`.

## 2. KDS server

- [x] 2.1 `GET /kds/api/state` adds `collections` and refunds per money reason, with a field-by-field projection (no payment references); verify in `tests/kds.test.mjs` that no reference or transaction id appears.
- [x] 2.2 `POST /kds/api/refunds`, `/kds/api/refunds/:id/status`, `/kds/api/rounds/:id/cancel`, `/kds/api/rounds/:id/resume`, `/kds/api/reservations/:id/release`, `/kds/api/dispatches/:id/retry`; verify in `tests/kds.test.mjs`: each works with the staff token, 401 without it and with the dispatch token, malformed ids → 404/400.

## 3. Kitchen screen

- [x] 3.1 "Cobros abiertos" panel in `public/kds/` with "Liberar", "Cancelar ronda" and "Reanudar cobro"; buttons on alerts for "Devolver" (dialog: kind, amount prefilled, reason, reference) and "Reintentar envío"; pending refunds with "Completada" / "Rechazada"; verify with Playwright specs in `tests/e2e/kds.spec.mjs` for refund-to-clear, cancel with confirmation (and dismissing it sends nothing), and retry.

## 4. Docs and verification

- [x] 4.1 Update README ("The kitchen display") and `docs/estado-actual.md` (option 2 done).
- [x] 4.2 `npm run test:all` green and `npm run audit` on the demo database still 10/10.
- [ ] 4.3 Live check on the demo with the Wompi sandbox (a lapsed-hold late payment cannot happen through the real checkout, which expires with the hold): a diner opens the checkout; staff cancel the round from "Cobros abiertos"; the diner pays anyway → the money is credited to the table and flagged (on return, or by the periodic check); staff resolve it with Devolver → Llegó and the table leaves the alerts.
