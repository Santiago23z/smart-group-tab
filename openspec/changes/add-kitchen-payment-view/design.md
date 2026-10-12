# Design

## Context

- Active tickets come from `kitchen_tickets`, projected field by field by `ACTIVE_TICKETS` in
  `src/kds/app.mjs`. The projection exists so that nothing a sender put in the ticket (a balance, a
  reference) reaches the screen.
- Whether a share is paid is already answered by `is_share_settled(share_id)`: a confirmed
  reservation owns it. Wompi and manual payments both settle through `confirm_webhook`, so one
  test covers both. Written-off shares are in `write_off_shares`; a hybrid round 2+ paid from
  the balance has `rounds.paid_from_balance` and no contribution.
- Every payment lands as one row in `contributions` (`order_amount`, `tip_amount`, `created_at`,
  `webhook_event_id`). The rail is `webhook_events.provider` (`'manual'` for the cash drawer and
  card terminal, anything else is Wompi); the manual method is `manual_payments.method`, joined on
  `webhook_event_id`. Completed refunds carry `refunds.completed_at`.
- Nothing in the schema stores a time zone. The product runs in Colombia only (Wompi Colombia),
  and several venues per account are out of scope.

## Goals / Non-Goals

**Goals:**
- Read-only: two SQL functions and their display. No write path, ledger row or invariant changes.
- The paid state is computed, never stored, so it cannot drift from the ledger.

**Non-Goals:**
- Keeping done tickets on screen, or a separate "to deliver" list.
- Takings for any day other than today, per-venue takings, exports or reports.
- Netting refunds against the total, or splitting Wompi by Nequi / PSE / card.

## Decisions

**D1. The payment state is one SQL function, called from the ticket projection.**
`round_payment_state(round_id) → 'unpaid' | 'paid' | 'written_off'`:
- `paid` if `rounds.paid_from_balance`;
- `unpaid` if any active share is neither settled nor written off;
- `written_off` if none is unpaid and at least one share was written off;
- `paid` otherwise.
`ACTIVE_TICKETS` adds `'payment', round_payment_state(k.round_id)`. Only the state word goes out:
the ticket still carries no amount.
*Alternative:* derive it in Node from `staff_collections` / `staff_open_tables`. Rejected: those
cover only rounds in collection and open tables, and a second definition of "paid" would drift.

**D2. Takings are one SQL function, read with the rest of the screen's state.**
`staff_takings_today() → {day, total, wompi, cash, card_terminal, tips, refunded}`, all `bigint`.
- Day window: `start = date_trunc('day', now() at time zone 'America/Bogota') at time zone
  'America/Bogota'`, end = start + 1 day. Rows are filtered by range, so an index on `created_at`
  could serve it later.
- `total` = Σ(`order_amount + tip_amount`) of contributions in the window, including those
  `applied_to_prepaid_balance`: the money did arrive.
- Split: a contribution whose event provider is `'manual'` goes to `cash` or `card_terminal` by its
  `manual_payments.method`; every other contribution goes to `wompi`. Each figure includes its
  tips, so `wompi + cash + card_terminal = total`.
- `refunded` = Σ `refunds.amount` with `completed_at` in the window, shown apart, never subtracted.
- The KDS state route adds `takings` from it, behind the same staff credential.
*Alternatives:* a `venues.time_zone` column, rejected for now: one country, one zone, and the
column can come with multi-venue. Summing in Node, rejected: money totals belong in SQL, `bigint`
end to end.

**D3. On screen.**
- Ticket: a small badge under the round number. *sin pagar* is amber-outlined (something is still
  owed), *pagado · por llevar* is green, *pérdida asumida* is grey. These match the screen's
  existing colour meanings.
- Takings: "Hoy $X" in the top bar, next to the clock. Tapping it opens a dialog with the
  breakdown (Wompi, efectivo, datáfono, propinas, devuelto hoy). The total is visible from the
  wall as asked; the detail stays one tap away.

**D4. The spec's no-amount rule is narrowed to tickets.**
Since `staff-actions`, the side panels already show totals and per-person amounts, so the literal
rule had stopped describing the screen. Tickets, what the cooks read, keep showing no amount. The
existing e2e check (`ticket` contains no `$`) stays as the guard.

## Risks / Trade-offs

- [At an open-tab table the kitchen taps *Listo* before the bill is paid, so the paid state is
  rarely seen there] → Stated in the proposal as a known limit. Keeping done tickets is a separate
  decision.
- [The takings total is visible to anyone in the kitchen] → The user asked for it on screen; the
  breakdown sits behind a tap. Hiding the total too would be a one-line change in `kds.js`.
- [`is_share_settled` runs once per share of each active ticket on every 3 s poll] → Active
  tickets are few (only those not yet done), and each has a handful of shares.
- [A payment recorded seconds before midnight shows in the old day] → Intended: the day is when
  the payment was recorded.

## Migration Plan

One additive migration (two `create function`, execute granted to nobody but the owner, as with
the other `staff_*` reads). Rollback: drop both functions and revert the two front-end files; no
data is written.
