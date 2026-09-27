# Design

## Context

- Every money RPC serializes on the round row (`lock_round`). Lock order is **session first,
  then round** (`20260916001100_session_and_cart.sql`). `prepaid_balance` lives on `sessions`.
- `refunds` exists with `kind`, `status`, `reason`, `external_reference`,
  `recorded_by_participant_id`, and a deferred constraint trigger enforcing the ceiling per
  contribution. Nothing writes to it yet.
- `confirm_webhook` settles an approval on its reservation's shares unless they were retaken or
  the amount differs; it only fires the kitchen when the round is still `locked_for_payment`. It
  does not look at `cancelled`, because nothing could reach `cancelled` until now.
- Alerts are derived (`staff_alert_reasons`, `staff_alerts`) over sessions in
  `requires_staff_attention`; nothing ever moves a session back out.
- The KDS server (`src/kds/app.mjs`) already authenticates staff with `KDS_STAFF_TOKEN` for
  `/kds/api/*`; its RPCs are revoked from `anon`/`authenticated`.

## Goals / Non-Goals

**Goals:** every action is one `SECURITY DEFINER` function that takes the same locks as the
payment path, re-checks its preconditions under them, logs itself, and re-evaluates the alert.

**Non-Goals:** write-offs and `close_session`; refunds of applied money; staff identity (the
token is shared; `recorded_by_participant_id` stays null); calling Wompi's refund API.

## Decisions

**D1 — One function per action, all in SQL.** `staff_record_refund`,
`staff_set_refund_status`, `staff_cancel_round`, `staff_resume_round`,
`staff_release_reservation`, `staff_retry_dispatch`. Each returns `{status, reason?}` like the
other RPCs, so a refused action is an ordinary answer the screen renders. Node stays a thin
shell. *Alternative*: logic in the KDS server — rejected, every other money rule lives in SQL
under the round lock, and a rule in Node would be outside it.

**D2 — Locks: round, then session.** Found while implementing: `confirm_webhook` credits a late
payment by locking the round and *then* updating the session, so the documented "session first"
order would let a staff action and a webhook deadlock. Round actions lock the round (and touch
the session last, in `staff_resolve_if_clear`); refunds lock only the session; retry locks the
dispatch row, then the session — the same order the worker uses when it marks a failure.

**D11 — Staff cancellations are rechecked at Wompi until the checkout dies.** The periodic check
skipped every cancelled reservation. A staff cancel is not a final outcome — the diner may still
be paying — so reservations cancelled by staff (round cancelled, or a logged release) keep being
checked until 10 minutes after their hold's expiry; declines are not.

**D3 — Refunds only against credited contributions, and they move the balance.** A credited
contribution (`applied_to_prepaid_balance`) already added its amount to `prepaid_balance`.
Recording a refund subtracts it (refused if the balance is lower — hybrid rounds may have spent
it); `rejected` adds it back; `completed` changes no balance. This keeps the balance equal to
"credit the table can still use". The ceiling trigger stays as a second guard; the session lock
is what prevents two concurrent refunds from both passing it. *Alternative*: refunds of applied
money too — rejected for the MVP: returning money for food already fired needs rules about the
round that belong with `close_session`.

**D4 — Cancel only when no money is applied.** "No money applied" = no contribution with
`applied_to_prepaid_balance = false` on the round. Credited contributions on the round do not
block (that money already sits on the session). Live reservations are set `cancelled`. A diner
still in Wompi's checkout may pay anyway; D5 makes that safe.

**D5 — `confirm_webhook` credits approvals for a cancelled round.** Before the settle path: if
the reservation's round is `cancelled`, take the credit path (reason `round_cancelled`), leave
the round `cancelled`, flag the session. Implemented as a `create or replace` of the current
body with one added branch; nothing else in it changes.

**D6 — Resume re-runs the release check.** `requires_staff_attention → locked_for_payment`, then
the same `round_is_fully_settled` → `paid_and_dispatched` + outbox transition `confirm_webhook`
uses (factored into one internal function both call), because approvals that landed while the
round was flagged could not release it: `confirm_webhook` only releases from
`locked_for_payment`.

**D7 — Retry resets the budget.** `failed → pending`, `attempts = 0`, `next_attempt_at = now()`,
`last_error` kept until the next attempt overwrites it. The worker needs no change.

**D8 — Alert re-evaluation is one function.** `staff_resolve_if_clear(session)`: if the session
is `requires_staff_attention` and `staff_alert_reasons` yields no real reason, set it `open`.
Every action calls it last. Reason changes: *money not placed* excludes contributions whose
`completed` refunds cover the amount and shows pending refunds; *collection stalled* is now every
round in `requires_staff_attention` (previously it excluded rounds with credit, which after a
refund left a flagged round with no reason at all).

**D9 — `staff_action_log`.** `(id, action text, target_id uuid, session_id uuid, detail jsonb,
created_at)`, insert-only, RLS on, no grants. Written inside each action's transaction, so a
refused or rolled-back action leaves no entry.

**D10 — Screen.** `GET /kds/api/state` adds `collections` (open rounds with outstanding and
live reservations: nickname, amount, expiry — no references, no payment ids) and, per money
reason, its refunds. New `POST /kds/api/...` routes, one per action. The page adds the
"Cobros abiertos" panel and buttons on each alert; refund and cancel open a confirmation dialog
with the amount and consequence (spec). After any action the page refreshes.

## Risks / Trade-offs

- [A diner pays a round after staff cancelled it] → D5: credited and flagged, never lost.
- [Staff refund credit the table meant to spend] → refused when the balance is lower; the
  dialog shows the balance.
- [Shared token: the log cannot say who acted] → accepted until staff accounts exist.
- [Resuming a round whose shares are all paid fires the kitchen] → intended (D6), tested.

## Migration Plan

One additive migration (new functions, table, and `create or replace` of `confirm_webhook` and
the two alert functions). Rollback: revert the KDS routes; the functions are unused without them.
