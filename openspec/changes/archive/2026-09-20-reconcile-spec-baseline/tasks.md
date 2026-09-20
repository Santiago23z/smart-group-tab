# Tasks

## 1. Baseline before touching anything

- [x] 1.1 Rebuild clean and record the green baseline: `npm run db:reset && npm run verify:schema && npm test && npm run audit`. Write down the check counts so any later drop is visible rather than inferred. Actual baseline: 37 structural checks, 88/88 tests, 9/9 audit invariants. (The 32 named in README.md is the phase-1 count; verify-schema.mjs has grown since.)
- [x] 1.2 Capture the live definitions of the four functions to be re-created, straight from the database catalog rather than the files: `select pg_get_functiondef(oid) from pg_proc where proname in ('open_or_join_session','close_round','reserve_contribution','confirm_webhook')`. Save the output — it is the diff target for task 2.4.

## 2. The rename migration

- [x] 2.1 Create `supabase/migrations/20260920000100_align_state_names.sql` (numbered after `20260916001300`). Verify the migration runner picks it up in filename order with `npm run db:migrate` on a database already at `001300`.
- [x] 2.2 Add the three rename statements: `round_status` `pending_payment` → `locked_for_payment`, `round_status` `needs_staff_attention` → `requires_staff_attention`, `session_status` `needs_staff_attention` → `requires_staff_attention`. Verify with `select enumlabel from pg_enum join pg_type t on t.oid = enumtypid where t.typname in ('round_status','session_status')` that the new labels exist and the old ones are gone.
- [x] 2.3 In the same migration, assert `refunds` is empty and raise a message naming the manual classification needed if it is not, then add `refund_kind` as an enum of `reversed`/`refunded` and `refunds.kind` as `not null`. Verify by inserting a refund without `kind` and confirming it is refused, and one with `kind = 'reversed'` and confirming it is accepted.
- [x] 2.4 Re-create `open_or_join_session` (from `...001100`), and `close_round`, `reserve_contribution`, `confirm_webhook` (from `...001200`), substituting only the affected literals. Verify by diffing each new body against the task 1.2 capture and confirming the only differences are the state literals — specifically that `confirm_webhook` still carries `and status = 'locked_for_payment'` on both the dispatch transition and the staff-attention transition, since `README.md` records that guard as undetectable by the suite.
- [x] 2.5 Reassert the `grant`/`revoke` statements for the four re-created functions, matching what `...001100` and `...001200` granted. Verify with `has_function_privilege` that the post-migration ACLs match the pre-migration capture. Corrected during implementation: `reserve_contribution` IS granted to `anon`/`authenticated` (`...000900:248`); `confirm_webhook` is the only one of the four that is revoked.
- [x] 2.6 Run `npm run verify:schema` to prove the whole chain applies in one transaction against PGlite. If the rename and the function re-creation cannot share a transaction, split into two migrations per design.md and re-run.

## 3. Confirm the rename left nothing behind

- [x] 3.1 Grep the live catalog, not the files, for surviving old labels: `pg_get_functiondef` over every function in `public`, plus `pg_indexes.indexdef` and `pg_policies.qual`/`.with_check`, for `pending_payment` and `needs_staff_attention`. Verify the result is empty.
- [x] 3.2 Verify the partial index `sessions_one_live_per_table` followed the rename automatically by reading its definition from `pg_indexes` and confirming the predicate now reads `requires_staff_attention`.

## 4. Tests

- [x] 4.1 Update state literals in `tests/helpers.mjs`, `tests/session-and-cart.test.mjs`, `tests/confirm-webhook.test.mjs`, `tests/wompi.test.mjs`, `tests/regressions.test.mjs`. Verify no assertion text changed — only literals — by reviewing the diff; a test that needs more than a literal substitution means the rename broke behavior and must be escalated, not patched.
- [x] 4.2 Update state literals in `scripts/verify-schema.mjs` and `scripts/audit-invariants.mjs`, and supply the new `kind` column in the refund insert the ceiling check performs (a direct consequence of task 2.3, not a loosened assertion). Verify with `npm run verify:schema` returning the same 37 recorded in task 1.1.
- [x] 4.3 Run `npm run db:reset && npm test && npm run audit` and verify the check count matches the task 1.1 baseline with zero audit violations.

## 5. Prove concurrency survived the rewrite

- [x] 5.1 Re-run the documented mutation: drop `FOR UPDATE` from `lock_round`, run `npm test`, verify 24–25 of 25 races overcommit, then restore it and verify the suite returns to green. A rewrite of four money functions with this mutation unre-run proves less than it appears to.

## 6. Diner PWA

- [x] 6.1 Update the four `pending_payment` matches in `public/app.js`. Verified by running `npm run web` and driving the same API the button drives: join -> add item -> close, and `/api/state` returns `locked_for_payment` with a non-zero `outstanding`, which is exactly what the four comparisons test. Then reserve -> pay, reaching `paid_and_dispatched` with 2 dispatch rows. NOT verified: the physical two-phone QR scan and the button rendering visually — no automated path exists for either.

## 7. Documentation

- [x] 7.1 Correct `CLAUDE.md`: replace `saldo_prepagado` with `prepaid_balance` in §3 and §5 (it violates §2's own English-only rule), document the fifth round state `cancelled` in §4, and state the refund model as kind (`reversed`/`refunded`) plus status (`pending`/`completed`/`rejected`) rather than the two collapsed into one. Verify by re-reading §3–§5 against the migrated schema.
- [x] 7.2 Update `README.md` wherever it names `pending_payment` or `needs_staff_attention`, including the invariants section and the mutation table. Verify with a grep of `README.md` for the old labels returning empty.

## 8. Land the spec baseline

- [x] 8.1 Verify the change validates: `openspec validate reconcile-spec-baseline --strict`.
- [x] 8.2 Sync the three deltas into `openspec/specs/` so `round-lifecycle`, `session-lifecycle` and `refund-registry` become the project's first durable specs. Verify with `openspec list --specs` returning all three with their requirement counts.
