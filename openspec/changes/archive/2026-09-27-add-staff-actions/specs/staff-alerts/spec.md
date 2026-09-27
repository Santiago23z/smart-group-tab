# Spec Delta

## MODIFIED Requirements

### Requirement: Tables that need a human are listed with their reason

The staff screen SHALL list every session in `requires_staff_attention`, showing its table and
every reason that applies:

- **money not placed**: a payment for the session was credited to its prepaid balance instead of
  being applied, with the credited amount and any refund recorded against it, until refunds
  `completed` against it cover the whole amount;
- **delivery failed**: a dispatch for one of its rounds is `failed`, with the channel and the last
  error;
- **collection stalled**: one of its rounds is in `requires_staff_attention`.

A session in `requires_staff_attention` for which no reason can be derived SHALL still be listed,
with an unknown reason. An alert that cannot explain itself is still an alert.

Sessions in any other state SHALL NOT be listed.

#### Scenario: A late payment

- **WHEN** an approved payment for a lapsed reservation is credited to a session's prepaid balance
- **THEN** that table is listed with reason "money not placed" and the credited amount

#### Scenario: A refund on its way

- **WHEN** a refund for the whole credited amount is recorded but still `pending`
- **THEN** the reason is still listed, showing the refund as pending

#### Scenario: The kitchen never received an order

- **WHEN** a dispatch for a round becomes `failed`
- **THEN** that round's table is listed with reason "delivery failed", the channel and the error

#### Scenario: A healthy table

- **WHEN** a session is `open`
- **THEN** it is not listed

## ADDED Requirements

### Requirement: An alert clears when its causes are resolved

After a staff action, if the session it concerns is `requires_staff_attention` and no reason
remains, the session SHALL return to `open`. A session that still has a reason SHALL stay
flagged, and an automatic event that creates a new reason SHALL flag it again.

#### Scenario: The late payment was returned

- **WHEN** the only reason a table was flagged is a credited payment, and staff mark its refund
  `completed`
- **THEN** the session is `open` and the table disappears from the alerts

#### Scenario: One of two problems solved

- **WHEN** a table has a credited payment and a failed delivery, and staff retry the delivery
- **THEN** the table stays listed with the money reason only
