# Design

## Context

- `switch_to_tab(session, participant)` (from `add-diner-chooses-payment`) locks the session,
  refuses while a round is in collection, sets `service_mode = 'open_tab'` and clears
  `requires_prepayment` on the draft round. It is one-way.
- `close_round` and `reserve_tab` both take the session row lock first. `reserve_contribution`
  (paying a round) locks the round row and refuses unless the round is `locked_for_payment`.
- `release_round_if_settled(round)` is the single dispatch transition: `update … set status =
  'paid_and_dispatched' where status = 'locked_for_payment'`, and only the call that changed the row
  inserts the two `dispatches` rows (`on conflict do nothing`). I2 rests on that guard.
- The tab (`session_tab_shares`) is every unpaid, unwritten-off share of a dispatched round with
  `requires_prepayment = false`.
- `reserve_tab` refuses `bill_not_requested` before the bill, for both `my_items` and `remaining`.
- `is_share_held(share)`: a confirmed reservation, or an active one inside its TTL.

## Goals / Non-Goals

**Goals:**
- One function changes the table's mode both ways, safe against every concurrent payment path.
- The switched round reaches the kitchen through the same guarded transition and outbox.
- A diner pays their own part of a tab before the bill with the existing tab reservation.

**Non-Goals:**
- Paying the waiter before the bill on a tab (cash requests and *Cobrar en caja* still need the
  bill). Per-diner modes. `hybrid` tables changing mode.

## Decisions

**D1. `set_table_payment(session, participant, mode)` replaces `switch_to_tab`.**
In one transaction:
1. Caller check (`current_participant_id()`), participant belongs to the session.
2. `select … from sessions … for update` — the lock `close_round` and `reserve_tab` take first.
3. Refuse: `invalid_mode` (not one of the two), `session_closed`, `bill_requested`,
   `hybrid_table`, `round_needs_staff` (any `requires_staff_attention` round). Same mode →
   `unchanged`.
4. Lock the session's `locked_for_payment` rounds `for update` (the lock `reserve_contribution`
   takes), then refuse `someone_paying` if any share of the session is held by a live (active,
   unexpired) reservation. Locking the rounds before checking means no round reservation can
   appear between the check and the update; the session lock covers tab reservations.
5. Set `service_mode`; set the draft round's `requires_prepayment` to the new mode's value
   (`requires_prepayment(session, number)` recomputed after the update).
6. If the new mode is `open_tab`: for each locked round, set `requires_prepayment = false` and run
   `release_round_to_tab(round)` (D2).
7. Answer `{status: 'changed', service_mode, dispatched_rounds: [...]}`.
`switch_to_tab` is dropped; the API route becomes `POST /api/table-payment {mode}`.
*Alternative:* keep `switch_to_tab` and add `switch_to_rounds`. Rejected: two functions with the
same guards drift.

**D2. `release_round_to_tab(round)` — the guarded transition without full settlement.**
Same body as `release_round_if_settled` minus the settlement test: `update … where status =
'locked_for_payment'`, and the `dispatches` insert only when that update changed a row. Called
only from D1, under the session and round locks. Two concurrent switches: the second waits on
the session lock, then sees `open_tab` and answers `unchanged`; even if it did not, the status
guard and `on conflict do nothing` keep dispatch exactly-once.
*Alternative:* add a flag to `release_round_if_settled`. Rejected: that function's whole contract
is "only when settled"; a flag would make the I2 path read differently for every caller.

**D3. Paying a round that lapsed and was switched.** No new code: a late approved payment for an
expired reservation on that round already goes through `confirm_webhook`, which places money only
on unpaid, unheld shares and otherwise credits the session and flags it (I3). The test suite
checks this path for a switched round.

**D4. `reserve_tab` before the bill.** The `bill_not_requested` refusal stays for `remaining`; for
`my_items` it applies only when the session is not `open_tab`. Nothing else changes: same holds,
same checkout, and paying does not touch `bill_requested_at` or `try_close_session`'s rule that a
session closes only after the bill.

**D5. Diner screen.**
- Cuenta tab: "Pasar a pagar al final" or "Pasar a pagar cada ronda", whichever applies, with the
  inline confirmation from `add-diner-chooses-payment`; shown when D1's conditions hold as far as
  the screen can tell, and the server has the last word.
- Pay sheet (round in collection, before any hold): "Seguir pidiendo y pagar todo al final" under
  *Pagar*, with the same confirmation, then D1 with `open_tab`.
- Bar at a tab table before the bill: when the diner owes something on the tab, "Lo tuyo hasta
  ahora $X · Pagar lo mío", reserving the tab with `my_items`. The cash/terminal options are hidden
  there (non-goal).

## Risks / Trade-offs

- [A diner switches the whole table without asking] → Confirmation says so; every phone shows the
  mode; any diner can switch back.
- [Someone is mid-checkout and the switch is refused] → The refusal says someone is paying; the
  hold lapses within the venue's reservation TTL (5 min) if abandoned.
- [Paying "lo mío" early, then ordering more] → The new items are a new part of the tab; the bar
  shows the new amount. Nothing is paid twice: paid shares are settled.
- [New dispatch path] → D2 keeps the exact I2 guard; tests run two switches concurrently and check
  one dispatch row per channel.

## Migration Plan

One migration: drop `switch_to_tab`, add `set_table_payment` and `release_round_to_tab`, replace
`reserve_tab`'s bill check, grants as the other diner calls. Rollback: restore the previous
`reserve_tab` and `switch_to_tab`; no data changes.
