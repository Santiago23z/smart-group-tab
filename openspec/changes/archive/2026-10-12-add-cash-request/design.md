# Design

## Context

- Unpaid parts: for a round in collection, a participant's free shares (`free_shares`); for a tab
  in settlement, `session_tab_shares`. `staff_record_manual_payment(scope, target, participant,
  method, …)` settles them; the KDS "Cobrar en caja" dialog (`openCash`) takes a list of choices.
- The diner app polls `/api/state`; the pay sheet (`#pay`) opens from the pay bar.

## Decisions

**D1 — `cash_requests`.** `(id, session_id, participant_id, scope 'mine'|'rest', method
cash|card_terminal, created_at, resolved_at, resolution 'cancelled'|'dismissed'|'paid')`, with a
partial unique index on `(participant_id) where resolved_at is null`. A new request resolves the
old one as `cancelled` first.

**D2 — The amount is derived, never stored.** `cash_request_target(session, participant, scope)`: if the session asked
for the bill, the tab (the participant's unpaid shares, or all of it for `rest`); otherwise the
free shares of rounds in `locked_for_payment` (same split). A request whose amount is 0 is not
listed — so any payment route ends it without code in each route. Held shares count as unpaid
but are flagged, so staff know someone is mid-Wompi.

**D3 — Functions.** `request_cash_payment(session, participant, scope, method)` (diner, caller
check, refused when nothing is unpaid); `cancel_cash_request(session, participant)` (diner);
`staff_dismiss_cash_request(id)` (staff, logged); and `staff_cash_requests()` for the KDS state
(open requests with amount > 0, the target for the cash dialog: round id or session, and the
participant). After a successful "Cobrar en caja" from a request, the screen dismisses nothing:
the paid part makes it disappear by D2.

**D4 — Screens.** Diner: in the pay sheet, under "Pagar", two secondary buttons "Pagar en
efectivo" / "Con datáfono"; while a request is open the pay bar reads "Esperando al mesero ·
efectivo" with "Cancelar". KDS: section "Quieren pagar" above the alerts with a count; each card
opens `openCash` with only that choice (and the method preselected).

## Risks / Trade-offs

- [A request lingers after the diner left] → staff dismiss it; it also vanishes when the table
  closes (its part is no longer unpaid).
- [Two waiters collect the same request] → the second "Cobrar en caja" finds nothing free and is
  refused, as today.
