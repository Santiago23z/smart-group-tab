# Spec Delta

## ADDED Requirements

### Requirement: Food that could not be sent to the kitchen flags the session

When a dispatch for a round reaches a terminal failure, the session that round belongs to SHALL
move to `requires_staff_attention` unless it is already `closed`.

The diners have paid and the kitchen never received the order, which no amount of retrying will
now fix. This is the same class of incident as money that could not be placed: a human at the
venue has to look at this table. A failed record that nothing surfaces is not an alert.

The round SHALL NOT be moved out of `paid_and_dispatched`. It was paid and it was released; the
failure is in delivery, and rewriting the round's state would make the ledger describe something
that did not happen.

#### Scenario: The kitchen display never accepted the order

- **WHEN** a dispatch for a round exhausts its attempts and becomes `failed`
- **THEN** the round's session moves to `requires_staff_attention`
- **AND** the round stays `paid_and_dispatched` with its dispatch timestamp intact

#### Scenario: A closed session is not reopened by a late failure

- **WHEN** a dispatch reaches terminal failure for a round whose session is already `closed`
- **THEN** the session stays `closed`
