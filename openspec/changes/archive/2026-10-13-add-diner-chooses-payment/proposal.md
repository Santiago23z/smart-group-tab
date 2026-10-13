# Proposal

## Why

Feedback from a real user: having to order and pay, order and pay, round after round, is tiresome
— above all for someone alone. Some diners want to pay each round; others want to keep ordering
and pay once at the end. That is the diner's decision, not the venue's. Today the venue decides
for every table, and a table that started paying each round cannot change its mind: to keep
ordering on a tab it would have to leave and open the table again.

## What Changes

- **The first diner at a free table chooses how the table pays**, on the join screen:
  **Pagar cada ronda** (`pay_before_order`: the kitchen gets each round once it is paid) or
  **Abrir cuenta y pagar al final** (`open_tab`: rounds go to the kitchen unpaid, everyone pays
  when the bill is asked for). Diners who join later see how the table pays and follow it.
- **A table paying each round can switch to a tab** at any time no round is being collected and
  the bill has not been asked for. From then on its rounds go to the kitchen unpaid; what it
  already paid stays paid and is not on the tab. The other direction is not offered.
- Every phone at the table says how the table pays.
- The kitchen's **"Cómo se cobra"** setting, built today in `add-service-mode-setting` and not yet
  merged, is **removed**: its two commits are reverted and that change is abandoned, not archived.
  The venue's configured mode is kept only as the fallback when a join states no choice.
- `hybrid` is not offered to diners; completing it is still a separate change.
- **Accepted risk:** any diner can now open a tab, so any table can eat and leave without paying.
  Staff already have *Asumir pérdida* for that; the venue can no longer force payment first.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `session-lifecycle`: the session's mode comes from the first diner's choice rather than the
  venue; a session may switch from paying each round to a tab, which clears the prepayment
  requirement of its draft round.

## Impact

- **Database:** one migration: `open_or_join_session` gains an optional mode; `table_status(qr)`
  tells the join screen whether the table is free and how an open one pays; `switch_to_tab`.
  No new column.
- **Code:** `src/api/server.mjs` (join with mode, table status, switch), `public/index.html` +
  `app.js` + `style.css` (choice on the join screen, how-the-table-pays line, switch button).
  `git revert` of `e3bf84a` and `1bd3235`, and removal of `openspec/changes/add-service-mode-setting`.
- **Tests:** SQL (choice, fallback, later joiner ignored, switch and its refusals, tab after a
  switch excludes paid rounds), API, e2e (choose a tab alone, switch mid-session and pay at the end).
- **Docs:** README, `docs/estado-actual.md` (modes are chosen by the diner), `CLAUDE.md` §5
  ("The mode … is snapshotted to the session upon creation" gains the diner's choice and the one
  switch).
- **No new dependencies.** I1–I3 are untouched: payments, holds and dispatch work per round as
  today; only which rounds need prepayment changes.
