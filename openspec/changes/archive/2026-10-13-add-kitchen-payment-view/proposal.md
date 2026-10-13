# Proposal

## Why

At a table with an open tab, a round reaches the kitchen before anyone pays, and the kitchen ticket
says nothing about money. Staff cannot tell from the screen which orders are already covered and
which still are not. The venue also has no single place to see how much it has taken today: the
figure is spread over Wompi, the cash drawer and the card terminal.

## What Changes

- Each kitchen ticket shows the payment state of its round, as a word, never an amount:
  **sin pagar** while some part of the round is unpaid, **pagado · por llevar** once every part is
  paid, **pérdida asumida** if the unpaid part was written off. The state follows payments on the
  next refresh, so an open-tab ticket turns from *sin pagar* to *pagado · por llevar* by itself.
  A round collected before the kitchen (`pay_before_order`, hybrid round 1) arrives already paid.
- The kitchen screen shows **today's takings**: the total money received today, with how much came
  through Wompi, cash and the card terminal, how much of it is tips, and the refunds completed
  today. "Today" is the calendar day in Colombia (America/Bogota).
- The `kitchen-display` rule "The screen SHALL show no amount, balance, share or payment
  reference" is narrowed to the **tickets**. It already did not hold for the staff panels
  (collections and open tables show totals since `staff-actions`); this change says so and adds
  the takings figure. Tickets keep showing no amount.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `kitchen-display`: tickets show their round's payment state; the no-amount rule applies to
  tickets; the screen shows today's takings.

## Impact

- **Database:** one migration with two read-only functions: the payment state of a round, and
  today's takings. No new table, no change to any write path.
- **Code:** `src/kds/app.mjs` (ticket projection and screen state), `public/kds/kds.js` and
  `kds.css` (ticket badge, takings in the top bar with a breakdown on tap).
- **Tests:** SQL tests for both functions, KDS state tests, e2e for the ticket turning paid and for
  the takings figure.
- **Docs:** README and `docs/estado-actual.md`.
- **No new dependencies.** No change to payments, rounds, dispatch or any invariant.
- **Known limit:** at an open-tab table the kitchen usually taps *Listo* before the bill is paid,
  and the ticket leaves the screen at that moment. The paid state is visible only while the ticket
  is still on screen; this change does not keep done tickets around.
