# Spec Delta

## Purpose

Defines how staff record money received outside Wompi — cash or the venue's card terminal — so
that it settles shares, releases rounds and closes tables exactly as a Wompi payment would, and
leaves an auditable record.

## ADDED Requirements

### Requirement: Staff record a payment received in cash or on the card terminal

Staff SHALL be able to record, with the staff credential, a payment received as `cash` or
`card_terminal`, with an optional reference and an optional tip, for either:

- one participant's part: that participant's free shares; or
- the rest: every free share,

of a round that is `locked_for_payment`, or of a session's tab once the bill was asked for. The
amount SHALL be exactly the sum of those shares plus the tip; staff SHALL NOT type it.

#### Scenario: Paying one diner's part in cash

- **WHEN** staff record a cash payment for Ana's part of a round in collection, where her shares
  total 30.000
- **THEN** those shares are paid, and a manual payment of 30.000 in cash is recorded for Ana

#### Scenario: The table pays the rest on the card terminal

- **WHEN** staff record a card-terminal payment for the rest of a tab of 80.000, with voucher
  "0457"
- **THEN** every unpaid share of the tab is paid and the payment is recorded with that reference

### Requirement: A manual payment settles exactly like a Wompi payment

A manual payment SHALL settle through the same rules as a Wompi approval: each share paid once,
the round released to the kitchen when it becomes fully paid, and the session closed when nothing
is left open. It SHALL NOT depend on any message from Wompi.

#### Scenario: The last part of a round is paid in cash

- **WHEN** the only unpaid part of a round in collection is recorded as paid in cash
- **THEN** the round is sent to the kitchen exactly once

#### Scenario: The last part of a tab is paid on the card terminal

- **WHEN** the rest of a tab is recorded as paid on the card terminal and nothing else is open
- **THEN** the table closes

### Requirement: A manual payment never takes what someone is paying in Wompi

Shares held by a live reservation SHALL NOT be included in a manual payment. When the chosen part
has no free shares, the request SHALL be refused with reason `nothing_available` and nothing
recorded.

#### Scenario: The diner is in the Wompi checkout

- **WHEN** Ana holds her shares in a live Wompi reservation and staff try to record her part as
  paid in cash
- **THEN** the request is refused and nothing is recorded

#### Scenario: Cash for the rest while one diner pays online

- **WHEN** Beto holds his shares in a live reservation and staff record the rest in cash
- **THEN** only the shares not held by Beto are paid

### Requirement: Every manual payment is recorded and auditable

Every manual payment SHALL be recorded with its method, amount, tip, reference, the participant it
was for (or the table's Caja for the rest), its session, and when it was recorded; and in the
staff action log. Records SHALL NOT be editable. A refused request SHALL record nothing.

#### Scenario: Reading back the night

- **WHEN** staff recorded two cash payments and one card-terminal payment at a table
- **THEN** three manual payment records exist with their methods, and the table's paid total
  includes all three

### Requirement: Staff confirm before recording

The kitchen screen SHALL show, before recording, the table, whose part it is (or "todo lo que
falta"), the amount and the method, and SHALL record nothing if staff dismiss it.

#### Scenario: Wrong person tapped

- **WHEN** staff open "Cobrar en caja" for Ana and dismiss the confirmation
- **THEN** nothing is recorded and Ana's part is still unpaid
