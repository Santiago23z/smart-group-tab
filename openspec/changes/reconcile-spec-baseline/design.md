# Design

## Context

See `proposal.md` — Why. Three constraints shape the approach.

**Migrations are append-only.** They are applied in filename order, one transaction each, and
recorded in `schema_migrations`. Editing `20260916000100_types_and_roles.sql` does nothing on an
existing database. The rename must therefore arrive as a new migration that alters what the old
ones built.

**The live definition of a function is the highest-numbered one.** Five of the seven write RPCs
are defined twice, with `...001200_review_fixes.sql` superseding `...000900`, `...001000` and
part of `...001100`. Grepping for `create or replace function <name>` finds the obsolete body
first. Any change to one means writing that whole function again.

**The values being renamed are load-bearing for concurrency-verified code.** `lock_round`'s
`FOR UPDATE` is the only mutual-exclusion mechanism in the system, and the guards around the
dispatch transition sit inside two of the four functions that must be rewritten. The suite is
known not to detect the removal of one of those guards.

## Goals / Non-Goals

**Goals:**

- Rename with zero behavior change, so that every existing test passes with only its state
  literals updated.
- Keep the rename in one migration, so the schema is never half-renamed between migrations.
- Make the new `refunds.kind` column impossible to populate wrongly by accident.

**Non-Goals:**

- Rewriting any RPC logic. This change touches four function bodies and must change nothing in
  them except the affected string literals.
- Adding a writer for `refunds`. The column is added; the staff RPC that fills it is a later
  step.
- Specs for capabilities the rename does not touch — share claiming, webhook ingestion, the
  Wompi adapter, RLS. Those are later steps.

## Decisions

### Rename the enum values in place rather than creating new types

`alter type round_status rename value 'pending_payment' to 'locked_for_payment'` renames the
`pg_enum` row and leaves its OID untouched. Every stored dependency that holds a *parsed*
reference follows automatically, because it points at the OID rather than the text. That covers
the partial index `sessions_one_live_per_table`, whose predicate is
`status in ('open', 'settling', 'needs_staff_attention')`, and any RLS policy or check
constraint over these columns.

**Alternative considered: create new enum types and swap the columns.** Rejected. It would
require dropping and recreating the partial index and every policy that depends on the column,
rewriting existing rows, and it rewrites the table. The rename does none of that and cannot lose
a dependency by omission.

**What the rename does not cover:** function bodies. Both PL/pgSQL and SQL functions here are
defined with `$$`-quoted bodies, which Postgres stores as text and parses at execution time.
A body containing `'pending_payment'` keeps that text and fails at runtime once the label is
gone. Those four bodies are the whole manual surface of this change.

### Re-create exactly four functions, from their live definitions

Only four functions still in force carry an affected literal:

| Function | Live definition | Literals |
|---|---|---|
| `open_or_join_session` | `...001100` | `needs_staff_attention` ×1 |
| `close_round` | `...001200` | `pending_payment` ×2 |
| `reserve_contribution` | `...001200` | `pending_payment` ×1 |
| `confirm_webhook` | `...001200` | `pending_payment` ×2, `needs_staff_attention` ×3 |

`add_cart_item`, `void_cart_item` and `set_item_sharing` reference only `'closed'` and
`'settling'`, which are unaffected, so they are left alone.

Each of the four is copied verbatim from its live definition into the new migration with only
the literals substituted. The copy must be diffed against its source to prove nothing else
moved — in particular the `and status = 'pending_payment'` guard on the dispatch transition in
`confirm_webhook`, which the mutation table in `README.md` records as **undetectable by the
suite**. If that guard is dropped during the copy, nothing goes red.

**Alternative considered: a scripted find-and-replace over the migration files.** Rejected —
migrations are append-only, so editing them changes nothing on an applied database while making
`npm run db:reset` and a running database silently disagree.

### Rename `needs_staff_attention` in both enums

`CLAUDE.md` §4 specifies only round states. Renaming `session_status`'s value as well is a
deliberate extension: leaving one enum with `needs_staff_attention` and another with
`requires_staff_attention`, both meaning the same thing about the same incident, is a trap for
whoever writes the KDS. The cost is one extra `alter type` and one extra literal in
`open_or_join_session`.

### `refunds.kind` is `not null`, guarded by an emptiness assertion

`refunds` has no writer anywhere in the codebase — no RPC inserts into it — so the table is
empty in every database that exists. `kind` is therefore added as `not null` with no default,
which is the honest shape: every refund has a kind, and there is no sensible value to invent for
a row whose kind nobody recorded.

Because a `not null` add against a non-empty table fails with a message about the column rather
than about the situation, the migration asserts emptiness first and raises a message naming what
a human has to do if rows exist.

**Alternative considered: `not null default 'refunded'`.** Rejected. A default silently
classifies historical refunds as the kind they may not be, and a wrong audit record about real
money is worse than a migration that stops.

**Alternative considered: nullable column.** Rejected. It pushes the "is this a reversal?"
question onto every future reader, and the spec says every refund has a kind.

### Verify the rename and the re-creation in one transaction is legal, do not assume it

`alter type ... add value` has documented restrictions about being used in the same transaction
that created it. `rename value` is a different operation with no such restriction in the
documentation, and function bodies are parsed at execution rather than creation, so re-creating
the four functions in the same migration transaction should be fine.

**This is reasoning, not a verified fact.** `npm run verify:schema` runs the full migration
chain against PGlite without needing a database, so it is the cheap way to find out. If the
single transaction turns out to be rejected, the fallback is two migrations — rename in one,
functions in the next — which costs nothing but leaves the schema briefly inconsistent between
them.

### Update the diner PWA in the same change

`public/app.js` matches on `pending_payment` in four places. It is not covered by any test, so a
missed occurrence surfaces as a screen that silently stops showing the pay button. It ships with
the migration rather than after it.

## Risks / Trade-offs

**Copying four function bodies silently drops a guard** → Diff every copied body against its
live source before running anything. `confirm_webhook`'s `and status = 'pending_payment'` guard
is specifically known to be invisible to the suite, so the diff is the only check that covers
it.

**The rename appears to work but a literal survives somewhere unsearched** → After migrating,
grep the *live database catalog* rather than the files: `pg_get_functiondef` over every function
in `public`, plus `pg_indexes` and `pg_policies`, for the old labels. A file-level grep cannot
see a function body that was created by an obsolete migration and never superseded.

**A test passes because its assertion was loosened rather than its literal updated** → The
proposal's rule applies: no test's assertions may change, only its state literals. Any test
needing more than a literal substitution is evidence the rename broke behavior, and is escalated
rather than fixed.

**The suite goes green but concurrency broke** → Re-run the documented mutation from
`README.md`: drop `FOR UPDATE` from `lock_round`, confirm 24–25 of 25 races overcommit, put it
back. A green suite after a rewrite of four money functions, with that mutation unre-run, proves
less than it appears to.

**Residual violations from an earlier bug are mistaken for new ones** → Rebuild clean before
concluding anything: `npm run db:reset && npm test && npm run audit`.

## Migration Plan

1. New migration file, numbered after `20260916001300_allocation_timestamps.sql`, in one
   transaction: the three `alter type ... rename value` statements, the `refunds` emptiness
   assertion and `kind` column, then the four re-created functions with their existing
   `grant`/`revoke` statements reasserted.
2. `npm run verify:schema` — proves the chain applies and the structural checks still pass,
   with no database required. This is where a same-transaction restriction would surface.
3. Update test literals, then `npm run db:reset && npm test && npm run audit`.
4. Update `public/app.js`, then exercise it through `npm run web`.
5. Correct `CLAUDE.md` and `README.md`.

**Rollback.** No rollback migration is written. The rename is not applied to any production
database — the only databases are local and rebuildable — so recovery is `npm run db:reset`
against the previous commit. Writing a down-migration for an append-only chain that has never
been deployed is ceremony.

## Open Questions

- The delivery channels enqueued on dispatch are `kds` and `print`, but §6 scopes the MVP to a
  KDS Web UI as the only staff surface. Whether `print` should still be enqueued is a question
  for the Outbox Worker change; it does not affect this one, since no worker reads either.
