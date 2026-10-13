# Spec Delta

## ADDED Requirements

### Requirement: A round in collection goes to the kitchen when its table switches to a tab

When a session switches to `open_tab` while one of its rounds is `locked_for_payment`, that round
SHALL stop requiring prepayment and SHALL be dispatched to the kitchen, through the same single
transition to `paid_and_dispatched` and the same outbox as any dispatch: exactly once, never twice
whatever runs concurrently.

The switch SHALL be refused while any share of that round is held by a live reservation. Shares
already paid SHALL stay paid; unpaid shares SHALL be on the tab from then on. A payment that
arrives later for a reservation of that round that had lapsed SHALL be handled as any late
payment: placed if its shares are still unpaid and unheld, credited to the session and flagged
otherwise.

#### Scenario: Half paid, then the table switches

- **WHEN** Ana and Beto each owe 15.000 in a round in collection, Ana has paid, and Beto switches
  the table to a tab
- **THEN** the round goes to the kitchen once
- **AND** Ana's part stays paid, and the tab holds Beto's 15.000

#### Scenario: Someone is in the checkout

- **WHEN** Beto holds a live reservation on his share of the round and Ana switches the table to a
  tab
- **THEN** the switch is refused, the round stays in collection, and nothing is dispatched

#### Scenario: Two switches at once

- **WHEN** two diners switch the same table to a tab at the same moment
- **THEN** the round is dispatched once and both answers agree the table runs a tab
