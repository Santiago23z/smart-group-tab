# Design

## Context

- Share state is allocation-based: `is_share_held` / `is_share_settled` look only at
  `reservation_allocations` joined to their reservation's status. Nothing in them depends on the
  reservation's round. This is what makes a reservation spanning rounds possible without new
  share rules.
- `contribution_reservations.round_id` and `contributions.round_id` are `NOT NULL`;
  `contributions.webhook_event_id` is unique (one event, one contribution).
  `reserve_contribution` only accepts `locked_for_payment` rounds, and every money RPC serializes
  on the round row.
- `open_tab` rounds go straight to `paid_and_dispatched` with no contribution. `hybrid` rounds
  2+ covered by the balance do the same after decrementing `prepaid_balance`, leaving no record
  of what paid them.
- `sessions.status` is one enum; `confirm_webhook` sets it to `requires_staff_attention` on
  credit, and `staff_resolve_if_clear` sets it back to `open`.
- Wompi reconciliation, checkout creation and the reservation TTL all work from the
  reservation row and its `psp_reference`.

## Goals / Non-Goals

**Goals:** one payment for a diner's whole tab with the same guarantees as a round payment
(I1: a share is never held twice or paid twice; I3: no approved payment lost); a table can
close; nothing about round payments changes.

**Non-Goals:** reopening a table after the bill; auto-applying credit to the tab; partial
write-offs; cash; `free_amount` or `specific_shares` for the tab (only "mine" and "the rest").

## Decisions

**D1 — A tab reservation is a reservation with no round.** `contribution_reservations` gets a
`session_id` (backfilled from the round, then `NOT NULL`) and `round_id` becomes nullable, with a
check that exactly the tab kind has it null. Its allocations point at shares from any round of
the session. `contributions` gets the same shape. Per-round attribution of a tab payment is its
allocations. *Alternatives*: (a) one child reservation per round under a parent "bill" sharing
one Wompi reference — rejected: one event would need N contributions, breaking the one-event
one-contribution guarantee, and N holds must expire and settle together; (b) re-open each served
round for collection — rejected by the user (one payment per round).

**D2 — Tab operations serialize on the session row.** A tab reservation, its settlement in
`confirm_webhook`, write-off and close all lock the session. No lock cycle: round payments take
round → session, staff round actions take round → session, tab operations take only the session.
Round and tab reservations never compete for the same shares: the tab is only shares of rounds
already sent to the kitchen, which `reserve_contribution` refuses (`round_not_collectable`).

**D3 — What the tab is.** `session_tab(session)`: active shares of rounds that are
`paid_and_dispatched` and neither `requires_prepayment` nor `paid_from_balance`, minus settled and
written-off shares. Rounds collected before the kitchen contribute nothing because their shares
are settled; the `requires_prepayment` filter is defence in depth.

**D4 — `rounds.paid_from_balance`.** `close_round`'s hybrid balance path sets it. Existing data
has no such rounds outside tests (hybrid is not seeded); no backfill. `close_round` is replaced
with that one-line change.

**D5 — `sessions.bill_requested_at`.** The settlement marker, independent of `status`.
`add_cart_item` and `close_round` refuse when it is set. (`set_item_sharing` / `void_cart_item`
need no change: the bill is refused while the draft has items, and nothing can be added after.) `request_bill` sets it and moves `open` → `settling`; a flagged session stays
flagged. `staff_resolve_if_clear` returns to `settling` when it is set.

**D6 — `reserve_tab(session, participant, mode, key, tip)`.** Modes `my_items` (the caller's
unpaid, unheld tab shares) and `remaining` (all unpaid, unheld tab shares). Same idempotency key
table, same `psp_reference` minting, same TTL. Refused unless the bill was asked for.

**D7 — `confirm_webhook` gains one early branch.** After the idempotency gate and reference
lookup, a reservation with no round goes to `confirm_tab_payment` (session lock; same
decline/duplicate/retaken/amount-mismatch logic as the round path; contribution with
`round_id` null; then `try_close_session`). The round path is untouched.

**D8 — Write-off records shares.** `write_offs(id, session_id, amount, reason, created_at)` and
`write_off_shares(write_off_id, cart_item_share_id, amount)`, append-only, RLS on. The write-off
takes every tab share at that moment; refused if any is held by a live reservation.

**D9 — `try_close_session`** checks six conditions and closes; `staff_close_session`
returns every blocking reason (`bill_not_requested`, `tab_unpaid`, `round_in_collection`,
`balance_left`, `refund_pending`, `alert_open`). `alert_open` was added while implementing:
closing a flagged table (say, a failed delivery) would make its alert vanish unresolved.

**D12 — Late money on a closed table stays visible.** Found while implementing: once a table
closes on its last payment, a lapsed reservation's delayed payment is credited to a `closed`
session, and alerts only listed flagged sessions — the money was recorded but no human was told.
Reopening is impossible (the QR may seat a new party), so `staff_alerts` also lists closed
sessions with unplaced money until it is refunded. Called after tab payments, write-offs and refund status
changes.

**D10 — Callers that assumed a round.** `createPaymentIntent` joins the session through
`reservation.session_id`; the diner state returns the live reservation whether round or tab;
`staff_release_reservation` locks the session for tab reservations; `staff_collections` lists
round reservations only; audits compute per-round money from allocations, and gain "no share is
both settled and written off" and "a closed session has no tab".

**D11 — Screens.** Diner: "Pedir la cuenta" when there is no unsent item; in settlement a tab
view (my part, table total, "Pagar lo mío", "Cubrir el resto") replacing the round bar; checkout
and return exactly as today. Kitchen: "Mesas abiertas" with tab and per-person parts, "Pedir la
cuenta", "Asumir pérdida" (confirm + reason), "Cerrar mesa" (shows blocking reasons).

## Risks / Trade-offs

- [`round_id` nullable touches every query that joins reservations or contributions to rounds]
  → D10 lists them; the full suite and audit run against both shapes; tests cover a tab payment
  through webhook, reconciliation and credit.
- [A write-off used as a discount] → whole tab only, reason required, only in settlement, logged.
- [A diner still in a tab checkout when staff write off] → refused while any tab share is held;
  after the hold lapses, a late payment is credited, as everywhere else.
- [Asking for the bill by mistake] → no reopening in this change; staff can still take orders
  outside the app. Named as a limitation.

## Migration Plan

One migration. Adds and backfills `session_id` before making `round_id` nullable; replaces
`close_round`, `confirm_webhook`, `add_cart_item`, `set_item_sharing`, `void_cart_item`,
`staff_resolve_if_clear`, `staff_release_reservation`. Rollback is a new migration; there is no
data to lose until a tab payment exists.
