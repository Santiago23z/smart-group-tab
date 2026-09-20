# Smart Group Tab

Real-time collaborative consumption platform for HORECA. A shared cart bound to a
physical table, with several people ordering and paying concurrently from their
phones, where **collection gates the kitchen**.

This is not a split payment app. There, the total is fixed and payment is
settlement after the fact. Here the cart is a mutable aggregate with concurrent
writers, and payment is the precondition for an irreversible physical action.

The payment rail is **instant push** (Wompi / Nequi / PSE). Money moves and does
not come back. So overcollection is not corrected — it is made impossible by
construction. That is the whole design.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Schema, constraints, RLS, policy functions, seed | **structurally verified** (32/32) |
| 2 | `reserve_contribution` — atomic share claiming | **verified under concurrency** |
| 3 | `confirm_webhook` — settlement, retries, late payments | **verified under concurrency** |
| 3.5 | Session and cart RPCs — the ordering half | **verified under concurrency** |
| 3.6 | Wompi adapter — signature, units, endpoint | **verified** |
| — | Code review: 8 defects found, 8 fixed | **9 invariants audited** |
| 3.7 | Payment creation — Web Checkout, signed, reference-threaded | **verified** (88/88 total) |
| 3.8 | Diner PWA — shared cart, fractional payment, on a phone | **verified in a browser** (12 specs) |
| — | State names aligned with CLAUDE.md; first three specs seeded | **147 checks total** |
| 4 | Dispatch outbox and worker | not started |
| 5 | KDS web (orders + staff alerts) | not started |

Phase 3.5 was not in the original plan. It got added because the money half was
finished and verified while the ordering half did not exist at all: there were
exactly two write RPCs in the whole system, and no legitimate way for a round to
reach `locked_for_payment` — the ledger tests fabricated it as superuser. Two decided
rules (D11 overflow, D18 voids) had no implementation, and `requires_prepayment()`
was written but called by nothing.

Still missing before a table can actually eat:

- **The dispatch worker.** Rows land in `dispatches` and nothing delivers them,
  so the kitchen never hears anything.
- **`close_session`.** `open_tab` accumulates consumption and nothing settles it
  at close — the modality has no ending. The strategy doc's §15 question, who
  covers an unpaid balance on an open tab, is still unanswered as well as unbuilt.
- **Staff actions** (D2, D17): force dispatch, release reservations, cancel round,
  record refund. Decided six phases ago, still absent.
- **A staff surface of any kind.** The diner's PWA is built and browser-tested;
  nothing on the other side of the counter exists at all.

## The Wompi bridge

```bash
npm run wompi    # see .env.example for the variables it needs
# POST /payments/intent   { reservation_id } -> a signed checkout URL
# POST /webhooks/wompi    whatever Wompi sends back
```

**There are two Wompi secrets and they do different jobs.** The *events* secret
verifies webhooks arriving from Wompi; the *integrity* secret signs the charge
going out. Swapping them fails in a way that reads like a key rotation problem —
checkouts rejected at their end, signatures failing at ours, nothing pointing at
the cause.

The charge uses **Web Checkout**, not the transactions API. A guest who scanned a
QR and typed a nickname has no email, no saved card and no account (D9); the
transactions API wants all of that plus an acceptance token and a per-method
payload. Wompi's own screen collects whatever Nequi or PSE needs.

The checkout is given the reservation's **own** `psp_reference` and the
reservation's **own** `expires_at`. Both matter:

- A fresh reference would come back on a webhook we cannot place, and the payment
  would land as unattributable table credit.
- A checkout outliving its hold is a diner paying for a share someone else has
  since taken. Recoverable — the money becomes credit and staff are told — but a
  bad minute for everyone, and avoidable for free.

Everything that decides anything is a plain function — `signature.mjs`,
`events.mjs`, `handler.mjs` — with no HTTP in it. `server.mjs` is a shell. That is
what lets the whole adapter be tested without a server, and what makes moving it
to a Supabase Edge Function a shim rather than a rewrite.

Three things in here are easy to get wrong:

**Units.** Wompi speaks `amount_in_cents`; the ledger stores COP in pesos, which
is the minor unit that actually circulates. The adapter divides by 100 and
refuses anything that is not a whole peso — a fractional peso means we and Wompi
disagree about what currency this is, and guessing is worse than stopping.

**Event identity.** Wompi sends no event id. The adapter uses
`${transaction.id}:${status}`, which is stable across retries and distinct across
transitions — so a retried `APPROVED` collides with itself at the idempotency
gate, while `PENDING → APPROVED` correctly does not.

**Check order.** Structure is validated *before* the signature. Parsing touches
nothing and cannot be exploited, and it means a genuinely malformed body returns
400 instead of a misleading 401 that would send someone hunting for a key
rotation problem that does not exist.

A missing `WOMPI_EVENTS_SECRET` is a startup crash, not a warning. An endpoint
without a secret accepts forged payments.

## Trying it on a phone

```bash
npm run web
```

Prints a QR in the terminal. Scan it, type a nickname, and you are at the table.
Open it on a second phone to see the shared cart move in real time, split a dish
between you, and race each other for the same balance.

No Wompi keys needed: the pay button settles through the real `confirm_webhook`,
so dispatch and every invariant behave exactly as they would with a genuine
callback. Add `WOMPI_PUBLIC_KEY` and `WOMPI_INTEGRITY_SECRET` and the same button
sends you to a real signed checkout instead. Set `ALLOW_SIMULATED_PAYMENTS=false`
to turn the shortcut off.

The API is a thin shell over the RPCs — no business logic lives in Node. It
passes the diner's identity through as `app.participant_id`, so the caller checks
added during the code review are genuinely exercised rather than skipped the way
a trusted service-role connection would skip them.

Two things about the screen are deliberate:

- **Nothing about money is computed in the browser, and nothing renders
  optimistically.** With an irreversible rail, a balance that is momentarily
  wrong is worse than one that is momentarily late.
- **Live updates are polling, and that is a placeholder.** With Supabase in place
  this becomes a Realtime subscription over the same `/api/state` shape — and it
  would still need the reconcile-on-focus that is already there, because a phone
  that slept through a round must not trust what it last saw.

## Watching it work without a phone

```bash
npm run demo
```

Drives a whole table through the real RPCs against the real database, narrating
each step: three phones scanning one QR at the same instant, a dish split three
ways, two people racing for the same balance, a tip that does not buy the food,
and the kitchen firing once. Nothing is stubbed.

## Testing

```bash
npm install
npm run verify:schema      # no database required
```

This runs the migrations and the seed against PGlite (Postgres in WASM) and
asserts the constraint triggers fire, the snapshots hold, the ledger refuses
mutation, and RLS denies every client write.

**It does not prove I1b or I2.** Mutual exclusion and exactly-once dispatch only
mean anything under real parallel connections, and PGlite is single-connection.
Those need a real server:

```bash
export DATABASE_URL='postgres://<you>@localhost:5432/smart_group_tab'
npm test
```

### Neither of those renders anything

Both prove the ledger is correct. Neither proves a diner can reach it, and that
gap is not theoretical: two bugs shipped in the first commit and stayed green
through every run of both suites.

The first was one CSS rule. The whole screen is driven by toggling the `hidden`
attribute, which hides anything only because of the browser's own
`[hidden]{display:none}` — and an author `display` declaration beats that,
because author origin outranks user-agent origin whatever the specificity.
`.sheet{display:flex}` therefore left the payment sheet permanently on top of
everything, so the app opened asking for a tip and swallowed every tap
underneath. The second: `refresh()` caught every error alike, which is right for
a dropped request in a loud bar but wrong for a session the server no longer has
— that one never reconciles, and the phone sat on an empty table screen with no
menu and no way back to the QR.

```bash
npx playwright install webkit   # once
npm run test:e2e
```

Twelve specs driving real WebKit at an iPhone viewport with real touch events,
against the real server against the real database: the screen opening clean, two
phones sharing one cart, splitting an item 17.280/17.280 with no drift, the cart
freezing on close, overflow into a new round, payment firing the kitchen exactly
once, a 50.000 tip failing to buy a 34.560 round while one share is unpaid, and
recovery from a session that no longer exists.

Each spec creates its **own table**. That is not tidiness: `sessions_one_live_per_table`
allows one live session per table, so two specs sharing one would be racing each
other for a tab rather than testing anything. Those rows accumulate until the
next `npm run db:reset`.

```bash
npm run test:all    # all 147: 38 schema + 88 node + 12 browser + 9 audit
```

### Why the races repeat 25 times

Because a single race is not a test. The window between reading share
availability and inserting the allocation is sub-millisecond, so with the row
lock removed a single round of eight racers still passes by luck perhaps a third
of the time.

This was found by mutation testing — dropping `FOR UPDATE` from `lock_round` and
re-running. At one round the suite let the bug through. At 25 rounds it catches
it every time: 24–25 of 25 races overcommit, with eight people paying a 12.000
balance for a total of 96.000 collected.

If you change anything about locking or share availability, re-run that mutation.
A concurrency test you have never watched fail is decoration.

### Auditing the data, not just the scenarios

```bash
npm run audit                      # every row
npm run audit -- --since <iso-ts>  # only what was written after a point in time
```

The suite proves the invariants hold for the cases someone thought to write.
`npm run audit` proves they hold for every row that exists.

That distinction is not academic. The worst defect found so far — an item worth
100 collecting 140 and firing the kitchen — was invisible to a green suite,
because it needed three conditions at once: a hold that lapses, a free-amount
claim that splits *that* share, and the original payment arriving late. Each was
tested alone. The audit found it in the data.

Run it against a database with history and you will see violations from before a
fix; `--since` separates the two. If it reports something you cannot place,
rebuild clean (`npm run db:reset && npm test && npm run audit`) before concluding
anything — residue from an already-fixed bug looks identical to a live one.

### What the mutations proved, and what they did not

| Mutation | Caught? | What it means |
|---|---|---|
| `lock_round` loses `FOR UPDATE` | yes, 24–25 of 25 races | The lock is load-bearing for I1b and I1c |
| Webhook idempotency gate never collides | yes, 2 tests | The gate is load-bearing for I2 |
| `add_cart_item` loses the session lock | yes | It is what keeps D11 overflow to one round |
| QR scan loses the table lock | yes | It is what keeps one table to one tab |
| `verifySignature` always returns true | yes, 6 tests | Forged payloads really are refused |
| The intent mints a fresh reference | yes, 2 tests | The reservation's reference really is threaded through |
| Wompi event id drops the status | yes | `PENDING → APPROVED` would be swallowed as a retry |
| Transition loses `and status = 'locked_for_payment'` | **no** | Redundant given the lock |

That last row is worth knowing rather than hiding. With the round locked, callers
serialize and only the one settling the final share ever observes a complete
round — so the status guard never fires, and neither does the `on conflict` on
`dispatches`. Both are kept as defence in depth against someone later weakening
the lock, but they are not what makes dispatch exactly-once today, and the suite
cannot tell you if they break.

## The invariants

Everything in this repo is scaffolding to hold up five statements. Each one gets
a dedicated concurrency test in phase 2.

- **I1a — Conservation.** The shares of an active cart item sum to exactly its
  `line_total`. Splitting a share preserves the sum.
- **I1b — Mutual exclusion per share.** No share is ever held by more than one
  live reservation.
- **I1c — No overcollection.** `sum(contributions.order_amount) <= round_total`.
- **I2 — Dispatch exactly once.** Never zero (paid food the kitchen never sees),
  never twice.
- **I3 — No approved webhook is ever lost.** Money that really moved is always
  recorded, even if it arrives late, duplicated, or against an expired
  reservation. Expiring never means rejecting.

## The core idea: shares

The atomic unit of debt is not the peso, it is the **share** — a fraction of a
cart item carrying an absolute amount in minor units. An item split three ways is
three shares of one `cart_item`.

Shares are divisible. A free-amount contribution that lands mid-share splits that
share into a covered portion and a remainder, inside the serialized section. Only
unclaimed shares are ever split.

That is why all six split modes are one mechanism:

| Mode | Expressed as |
|---|---|
| Pay for my own items | Claim my shares |
| Equal split | Re-shard the round into N equal shares, each claims one |
| Manual product selection | Claim the shares I pick |
| Shared item across 2, 3 or more | The item has N shares; each claims one |
| Cover the remaining balance | Claim every free share |
| Free amount | Claim free shares up to the amount, splitting the last |

## Serialization

`select * from rounds where id = ? for update` is **the only mutual-exclusion
mechanism in the system**, and every money RPC takes it first.

This is deliberate. A partial unique index over `reservation_allocations
(cart_item_share_id)` cannot work, because its predicate would have to read
"belongs to a reservation that is confirmed, or active and not yet expired" — and
a partial index predicate must be `IMMUTABLE`, which `now()` is not. The row lock
has no such restriction, and contention is ~10 people per table.

The cost is that the rule becomes structural rather than declarative: **RLS is
read-only for clients on every table, and all writes go through `SECURITY
DEFINER` RPCs that lock the round first.** A client that could `INSERT` directly
would bypass the only serialization point there is.

## Snapshots

Three values are copied rather than referenced, all for the same reason — live
state must not mutate under a table that is mid-service:

1. `sessions.service_mode` — a venue switching from `hybrid` to `open_tab` at
   11pm must not change the rules for tables already open.
2. `cart_items.unit_price` / `.tax_rate` — a menu price change must not move the
   total of a round that already has live reservations against it.
3. `cart_item_shares.owed_amount` — absolute, never a fraction. Fractions drift;
   `allocate_evenly` distributes remainders so sums stay exact.

## Running it

The runner is plain `pg`, not the Supabase CLI, on purpose: the CLI needs Docker,
and the concurrency tests need real parallel connections more than they need
Realtime.

```bash
brew install postgresql@17
brew services start postgresql@17
createdb smart_group_tab

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"   # versioned formula
export DATABASE_URL='postgres://<you>@localhost:5432/smart_group_tab'

npm install
npm run db:migrate
npm run db:seed

npm run db:reset        # drop and rebuild from scratch
```

Verified against PostgreSQL 17.11. Any 14+ should work; the schema uses nothing
newer than generated columns and `gen_random_uuid()`, both core since 13.

Supabase-specific surfaces (Realtime for the KDS, PostgREST) arrive in phases 4
and 5. The schema is written to run in both: `current_participant_id()` reads a
verified JWT claim when one is present and falls back to a session GUC
(`app.participant_id`) otherwise, so the same RLS policies hold in tests and in
production.

## Layout

```
supabase/migrations/   schema, in order
supabase/seed.sql      one venue, three tables, a menu
scripts/db.mjs         migrate / seed / reset
tests/                 concurrency tests (phase 2)
```
