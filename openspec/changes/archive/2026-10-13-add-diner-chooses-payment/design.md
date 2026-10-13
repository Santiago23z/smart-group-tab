# Design

## Context

- `open_or_join_session(qr, nickname)` locks the table row, opens a session if none is live
  (copying `venues.default_service_mode`), and joins it. Ten phones scanning at once open one
  session because of that lock.
- `ensure_draft_round` fixes `rounds.requires_prepayment` from `requires_prepayment(session,
  number)` when a draft is created. `close_round` then collects (`locked_for_payment`) or
  dispatches. The tab (`session_tab_shares`) holds only dispatched rounds with
  `requires_prepayment = false`, so rounds collected before the kitchen never land on it.
- `request_bill_core` sets `bill_requested_at` and moves `open` → `settling`.
- The join screen today only asks for a nickname; nothing tells it whether the table is free.
- `add-service-mode-setting` (commits `1bd3235` plan, `e3bf84a` code) added the kitchen's mode
  choice. It is on the unmerged branch `kitchen-payment-view`, after `add-kitchen-payment-view`.

## Goals / Non-Goals

**Goals:**
- The mode decision moves to the diner with no change to how a round is collected, paid, held or
  dispatched.
- One forward switch, guarded so no round in collection changes rules under a payment.

**Non-Goals:**
- Switching back from a tab to paying each round.
- Per-diner modes inside one table.
- `hybrid` for diners, or any prepaid deposit.
- A venue option to forbid tabs (the user chose "always the diner").

## Decisions

**D1. `open_or_join_session(qr, nickname, mode text default null)`.**
Replaces the two-argument function (dropped, so there is one signature; old two-argument calls
still resolve to it through the default). When it opens a session it uses `mode` if it is
`pay_before_order` or `open_tab`, the venue's mode if `mode` is null, and refuses `invalid_mode`
otherwise, before opening anything. When it joins a live session it ignores `mode`. The answer
already carries `service_mode`; it adds `chose: true|false` so the screen can say "this table
already pays at the end" when a diner's choice lost a race.
*Alternative:* open the session with no mode and ask after joining. Rejected: a session with no
mode is a new state every round function would have to handle.

**D2. `table_status(qr) → {status: 'free'|'open'|'unknown', venue, service_mode?}`.**
`SECURITY DEFINER`, executable by `anon`, read-only. It returns the venue name (already printed
on the table's QR card) and, for an open table, its mode — no session id, nickname or amount.
`GET /api/table?qr=…` exposes it. The join screen calls it on load.
*Risk:* anyone with a QR can tell whether that table is occupied. Acceptable: the QR sits on the
table, and walking past shows the same.

**D3. `switch_to_tab(session, participant)`.**
`SECURITY DEFINER`, executable by `anon`/`authenticated` like the other diner calls, checks the
participant belongs to the session (`current_participant_id()` as the others do). Locks the
session row, then:
- refuses `session_closed`, `bill_requested`, `not_paying_each_round` (mode is not
  `pay_before_order`), `round_in_collection` (any round `locked_for_payment` or
  `requires_staff_attention`);
- sets `sessions.service_mode = 'open_tab'` and `requires_prepayment = false` on the session's
  `draft` round, in one transaction;
- answers `{status: 'switched'}`.
Holding the session lock while checking round states matches `close_round`, which takes the same
lock first, so a round cannot be closed into collection between the check and the switch.
*Why safe for I1–I3:* no round in collection exists, so no hold or payment is in flight against a
round whose rule changes; closed rounds keep `requires_prepayment`, so the tab never re-charges
them.

**D4. Diner screen.**
- Join screen: after `table_status`, a free table shows two cards above the nickname field —
  **Pagar cada ronda** ("La cocina recibe cada pedido cuando está pagado") and **Abrir cuenta y
  pagar al final** ("Piden lo que quieran y pagan al pedir la cuenta") — none preselected; *Entrar*
  stays disabled until one is chosen. An open table shows one line instead ("Esta mesa paga al
  final" / "…paga cada ronda").
- Table header: a line under the round number says how the table pays.
- Switch: in the Cuenta tab, while allowed, a text button "Pasar a pagar al final". The first tap
  turns it into a short confirmation ("Desde ahora la comida llega sin pagar y pagan al pedir la
  cuenta." + *Sí, pasar* / *No*); the server decides, and a refusal shows its reason.

**D5. The kitchen setting goes by revert.**
`git revert e3bf84a 1bd3235` on this branch, then delete `openspec/changes/add-service-mode-setting`
(it is never archived, so its staff-actions delta never reaches the main specs). Reverting also
undoes the `venue:load --mode` fix from that change; with diners choosing, the venue's mode is only
a fallback, so the fix no longer matters.
*Alternative:* hand-remove the code and keep the `venue:load` fix. Rejected: a revert is exact and
leaves history readable.

## Risks / Trade-offs

- [Walkouts: any table can now run a tab] → Accepted by the user; *Asumir pérdida* records it.
- [Two diners at a free table choose differently at the same moment] → The table lock serializes
  them; the second joins the first's session and is told how it pays (`chose: false`).
- [A diner switches the whole table to a tab without asking the others] → Any diner can; the
  confirmation says it applies to the table, and every phone shows the new mode on its next poll.
- [Old cached join screens send no mode] → They get the venue's mode, as today.

## Migration Plan

One migration (drop and recreate `open_or_join_session` with grants, add `table_status` and
`switch_to_tab`). Existing sessions keep their mode. Rollback: restore the two-argument function
and drop the two new ones; no data changes.
