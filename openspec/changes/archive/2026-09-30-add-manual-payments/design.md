# Design

## Context

- `confirm_webhook(provider, event_id, reference, outcome, amount, payload, verified)` is the only
  way money reaches the ledger. `webhook_events` is keyed by `(provider, event_id)`; every
  contribution names one (audit I3). The round path releases to the kitchen and tries to close
  the table; the tab path (`round_id` null) does the same under the session lock.
- `reserve_contribution` (round) and `reserve_tab` (session) hold free shares for a participant
  with modes `my_items` / `remaining`; the caller check passes on the servers' own connection.
- `participants.kind` already has `staff`; equal splits only use `guest`s.
- The KDS state already lists open collections (with live holds) and open tables (with each
  person's unpaid tab).

## Goals / Non-Goals

**Goals:** cash and card-terminal payments settle through the existing path, with no second
settlement implementation; the record says how the money came in.

**Non-Goals:** undo; typed or partial amounts; cash drawer totals; per-staff attribution (shared
token).

## Decisions

**D1 — Manual payments are events with provider `manual`.** `staff_record_manual_payment`
reserves (round or tab, `my_items` for a participant or `remaining`) and, in the same
transaction, calls `confirm_webhook('manual', <uuid>, <reference>, 'approved', <amount>,
{method, reference, source: 'staff'}, true)`. Every rule — shares taken once, release, close —
is the one Wompi payments already pass. *Alternative* (the one first suggested): a `source`
column on `contributions` and a nullable `webhook_event_id` — rejected: it opens a second path to
write contributions, and I3 ("every contribution names an event") would no longer be checkable.

**D2 — `manual_payments` table.** `(id, session_id, round_id null, participant_id,
reservation_id unique, webhook_event_id unique, method cash|card_terminal, amount, tip,
reference, created_at)`, append-only, RLS on, no grants. It is the human-readable record; the
event and contribution are the ledger.

**D3 — The rest is paid by a per-session Caja participant.** `session_caja(session)` returns the
session's `staff` participant named "Caja", creating it if missing (a guest already named "Caja"
gets "Caja (local)"). It never receives shares, so it never appears as owing anything.

**D4 — Amounts are derived, never typed.** The reservation decides the amount (free shares of the
part or of the rest); the tip is the only input. So a manual payment cannot mismatch, and cannot
touch shares a Wompi reservation holds.

**D5 — Locks.** The RPC calls `reserve_contribution` (round lock) or `reserve_tab` (session lock),
then `confirm_webhook`, which takes the same lock again in the same transaction: no new ordering.

**D6 — Screen.** "Cobrar en caja" on each open collection and on each open table once the bill
was asked for. A dialog lists each person with a free unpaid part plus "Todo lo que falta",
method (Efectivo / Datáfono), reference and tip; the confirm step shows table, person, amount and
method. Refusals use the existing notice.

## Risks / Trade-offs

- [Staff record a payment by mistake] → confirmation step; no undo in this change (named).
- [A diner is mid-checkout for the same part] → excluded by D4; refused if nothing is free.
- [Caja name collision] → D3 fallback name; uniqueness is per session.

## Migration Plan

One additive migration. Rollback: remove the KDS route; nothing else calls the new function.
