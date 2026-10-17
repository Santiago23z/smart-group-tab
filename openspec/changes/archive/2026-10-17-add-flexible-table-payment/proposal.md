# Proposal

## Why

User feedback on how a table pays, after `add-diner-chooses-payment`:

- The moment a diner wants to stop paying each round is when the app asks them to pay again —
  but today the switch to a tab is refused exactly then, while a round is in collection.
- A table must be able to change how it pays once seated, in **both** directions, not only from
  paying each round to a tab.
- At a table running a tab, nobody can pay their part before the bill is asked for, and asking
  for the bill stops everyone from ordering. Someone leaving early has no way out but the waiter.

## What Changes

- **A table changes how it pays, both ways, from any diner's phone.** "Pagar cada ronda" ↔
  "Pagar al final", for the whole table, as long as nobody is in the middle of paying (no live
  hold on any share), the bill has not been asked for, and no round needs staff. Rounds already
  sent to the kitchen keep their rule; the round being built follows the new one.
- **Switching to a tab while a round is in collection sends that round to the kitchen.** What was
  already paid of it stays paid; what is unpaid goes on the tab. This is the one new way a round
  reaches the kitchen without being fully collected, and it is exactly-once like every other.
- **The pay sheet offers it where it is needed:** next to *Pagar*, "Seguir pidiendo y pagar todo
  al final" switches the table and sends the round to the kitchen.
- **On a tab, "Pagar lo mío" works before the bill.** Any diner can pay their own unpaid part at
  any time and keep ordering; "cubrir el resto" stays a settlement action. Asking for the bill is
  unchanged.
- The one-way `switch_to_tab` and its "A table paying each round can switch to a tab" requirement
  are replaced.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `session-lifecycle`: a table changes how it pays both ways; the draft round follows.
- `round-lifecycle`: a round in collection goes to the kitchen when its table switches to a tab.
- `tab-settlement`: a diner pays their own part of a tab before the bill.
- `diner-screen`: the pay sheet offers to pay at the end; the switch reads both ways; on a tab the
  bar offers "Pagar lo mío" before the bill.

## Impact

- **Database:** one migration: `set_table_payment(session, participant, mode)` replacing
  `switch_to_tab`; a guarded `locked_for_payment` → `paid_and_dispatched` release for a switched
  round; `reserve_tab` accepts `my_items` before the bill on `open_tab` sessions.
- **Code:** `src/api/server.mjs`, `public/index.html` + `app.js` + `style.css`.
- **Tests:** SQL (both directions, the switched round, refusals with a live hold, early tab payment,
  no double dispatch, no double charge), API, e2e.
- **Docs:** README, `docs/estado-actual.md`, `CLAUDE.md` §5.
- **Non-goals:** paying the waiter (cash / card terminal) before the bill on a tab; per-diner modes.
- **No new dependencies.** I1 (a share held or paid once), I2 (dispatch once) and I3 (no lost
  webhook) must hold through the new transition; the tests target each.
