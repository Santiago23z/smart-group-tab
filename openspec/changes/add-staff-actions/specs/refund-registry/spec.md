# Spec Delta

## ADDED Requirements

### Requirement: Staff record refunds of credited money

Staff SHALL be able to record a refund, choosing its kind, amount, reason and an optional
external reference, only against a payment that was credited to the session rather than applied
to food. Refunds of applied payments SHALL be refused.

Recording a refund SHALL reduce the session's prepaid balance by its amount, so money being
returned cannot also be spent. A refund SHALL be refused if it exceeds that balance, as well as
under the ceiling this registry already enforces.

#### Scenario: Returning a late payment

- **WHEN** a late payment of 144.720 was credited to a table and staff record a `refunded` refund
  of 144.720
- **THEN** a `pending` refund exists and the table's prepaid balance drops by 144.720

#### Scenario: The credit was already spent

- **WHEN** a table's prepaid balance is 10.000 and staff try to refund 30.000 of credited money
- **THEN** the request is refused and nothing changes

#### Scenario: Refunding money that paid for food

- **WHEN** staff try to refund a payment that was applied to a round
- **THEN** the request is refused

### Requirement: Staff move a refund to completed or rejected

Staff SHALL be able to mark a `pending` refund `completed` or `rejected`. `completed` and
`rejected` SHALL be final. Rejecting a refund SHALL return its amount to the session's prepaid
balance, since the money never left.

#### Scenario: The transfer bounced

- **WHEN** staff mark a `pending` refund of 30.000 as `rejected`
- **THEN** its status is `rejected` and the table's prepaid balance rises by 30.000
