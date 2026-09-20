# Proposal

## Why

The project's doctrine lives entirely in prose (`README.md`, `CLAUDE.md`) while
`openspec/specs/` is empty, so there is no machine-checkable statement of what the system
must do. A file-by-file comparison of `CLAUDE.md` against the 13 migrations found that most
of it is already built and verified, but three names disagree with the schema: round and
session states, and the refund model. Those disagreements are cheap to fix now and get
expensive once the Outbox Worker and the KDS — both unbuilt and both readers of round state —
are written against whichever name their author happened to read.

This change establishes the spec baseline for the surfaces where the disagreement lives, and
makes the schema match `CLAUDE.md` rather than the reverse. It is the first of several
steps; capabilities that already agree (share claiming, webhook ingestion, the Wompi
adapter, RLS) are documented in later changes.

## What Changes

**Naming reconciliation — `CLAUDE.md` is authoritative.** Three discrepancies were found
between `CLAUDE.md` and the schema. The decision is to move the code, not the document.

- **BREAKING** `round_status` value `pending_payment` is renamed to `locked_for_payment`
  (`CLAUDE.md` §4).
- **BREAKING** `round_status` value `needs_staff_attention` is renamed to
  `requires_staff_attention` (`CLAUDE.md` §4).
- **BREAKING** `session_status` value `needs_staff_attention` is renamed to
  `requires_staff_attention`. `CLAUDE.md` §4 specifies only round states; renaming the
  session value as well is a deliberate extension, taken so the schema does not carry two
  near-identical names with different meanings.
- `round_status` retains a fifth value, `cancelled`, which `CLAUDE.md` §4 does not list. It
  is documented rather than removed — no code reaches it today, and staff round cancellation
  (D2) is a decided-but-unbuilt feature that needs it.
- The `refunds` table gains a `kind` column with values `reversed` and `refunded`
  (`CLAUDE.md` §4) and keeps its existing `status` lifecycle
  (`pending`/`completed`/`rejected`). The two are orthogonal: `kind` records how the money
  came back, `status` records how far along it is. Collapsing them would contradict
  `README.md`'s own reason for modelling refunds honestly — the UI must not claim the money
  is back while the bank is still processing — and would break the
  `refunds_completed_at_matches_status` constraint.
- `CLAUDE.md` is corrected where it contradicts itself: §3 and §5 name a column
  `saldo_prepagado`, which violates its own §2 rule that every technical name be strictly
  English. The column is and stays `prepaid_balance`.

**Spec baseline.** The three capabilities the reconciliation touches get their first spec,
describing behavior that already exists and is already verified, with the new names. This is
documentation of built behavior, not new behavior — except where explicitly marked above.

**Not in this change:** the Outbox Worker, the KDS Web UI, staff action RPCs, and
`close_session`. All four are missing and all four are needed for the §6 MVP; each is its own
step.

## Capabilities

### New Capabilities

- `round-lifecycle`: The states a round moves through, what each state permits, cart freeze
  and overflow into a fresh `draft` round when a round locks, and the rule that item removals
  are only legal while the round is `draft`.
- `session-lifecycle`: Session states, the service-mode snapshot taken at open time, the
  prepaid balance pool, and how `hybrid` finances rounds 2+ against it.
- `refund-registry`: How a refund is recorded for audit — its kind, its lifecycle, and the
  ceiling that stops a contribution being refunded for more than it was worth — given that
  the physical money return is executed manually by staff.

### Modified Capabilities

None. `openspec/specs/` is empty; `openspec list --specs` reports no specs.

## Impact

**Schema.** One new migration. Migrations are append-only and applied in filename order, so
the rename cannot edit `20260916000100_types_and_roles.sql`; it must `alter type ... rename
value` and then re-create every function whose body carries an affected literal. Literal
counts found by grep:

| File | `pending_payment` | `needs_staff_attention` |
|---|---|---|
| `20260916000900_reserve_contribution.sql` | 1 | — |
| `20260916001000_confirm_webhook.sql` | 3 | 2 |
| `20260916001100_session_and_cart.sql` | 2 | 1 |
| `20260916001200_review_fixes.sql` | 5 | 3 |

`alter type ... rename value` rewrites no rows, but a string literal inside a PL/pgSQL body
is cast to the enum at execution time, so every affected function body must be written out
again in the new migration. Per `CLAUDE.md`, the live definition of each is the
highest-numbered one, which is `...001200` for five of the seven write RPCs.

**Tests.** Seven files carry affected literals: `tests/helpers.mjs`,
`tests/session-and-cart.test.mjs`, `tests/confirm-webhook.test.mjs`, `tests/wompi.test.mjs`,
`tests/regressions.test.mjs`, plus `scripts/verify-schema.mjs` and `scripts/audit-invariants.mjs`
where they reference round or session state.

**Diner PWA.** `public/app.js` matches on `pending_payment` in 4 places.

**Docs.** `CLAUDE.md` §3 and §5 (`saldo_prepagado` → `prepaid_balance`), §4 (document
`cancelled`; refund kind vs. status). `README.md` where it names the old states.

**Risk.** The renamed values are load-bearing for code verified under concurrency (88 checks
across `npm test`, `npm run verify:schema`, `npm run audit`). The rename is mechanical, but
re-writing five RPC bodies is the kind of edit that can silently drop a guard. The full
suite plus the documented `FOR UPDATE` mutation must be re-run, not just the suite.

**No behavior change** is intended anywhere except the new `refunds.kind` column. Every
existing test must pass with only its state literals updated; a test that needs its
assertions changed is a signal that the rename broke something.
