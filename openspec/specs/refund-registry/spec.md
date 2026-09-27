# refund-registry Specification

## Purpose

Defines how money returned to a diner is recorded so the ledger stays balanced, given that the
physical return is performed by a staff member rather than through the payment provider's API.
The registry is an audit trail over real money, not an instruction to move it.

## Requirements

### Requirement: A refund records how the money came back and how far along it is

A refund record SHALL carry two independent attributes.

**Kind** SHALL be either `reversed` or `refunded`. `reversed` means the original charge was
voided inside the provider's reversal window; `refunded` means the money was returned as a
separate movement afterwards. Which one is possible depends on the payment method and the
provider.

**Status** SHALL be `pending`, `completed`, or `rejected`, describing how far the return has
progressed. A refund SHALL start `pending`.

These SHALL NOT be collapsed into one attribute. A reversal that the bank is still processing
is `reversed` and `pending` at once, and the interface SHALL NOT present it as money already
returned.

A refund SHALL carry a completion timestamp if and only if its status is `completed`.

#### Scenario: A reversal still in flight

- **WHEN** staff record a reversal that the bank has not yet processed
- **THEN** the record has kind `reversed` and status `pending` and no completion timestamp

#### Scenario: A refund confirmed

- **WHEN** staff mark a `pending` refund as completed
- **THEN** its status is `completed` and it carries a completion timestamp

### Requirement: A refund cannot exceed what was paid

The refunds recorded against one contribution, excluding those whose status is `rejected`,
SHALL never total more than that contribution's order amount plus its tip amount.

An attempt to record a refund that would breach this ceiling SHALL be refused and SHALL leave
the registry unchanged.

#### Scenario: Refunding more than was paid

- **WHEN** a contribution of 30.000 already has a 30.000 refund recorded and staff record
  another 5.000
- **THEN** the request is refused and only the original 30.000 refund remains

#### Scenario: A rejected refund frees its amount

- **WHEN** a contribution of 30.000 has a 30.000 refund whose status is `rejected`
- **THEN** staff may record a new refund of up to 30.000 against it

### Requirement: Refunds carry a reason and an external reference

Every refund record SHALL carry a non-empty reason. It SHALL be able to carry an external
reference — whatever the staff member can point at, such as a transfer id, a cash receipt
number, or a point-of-sale void reference — and the participant who recorded it.

#### Scenario: Recording without a reason

- **WHEN** staff attempt to record a refund with an empty reason
- **THEN** the request is refused

### Requirement: The MVP does not execute refunds through the provider

Recording a refund SHALL NOT call the payment provider's refund API. The system SHALL treat the
record as a statement about a return a human performed or is performing.

#### Scenario: Recording a refund moves no money

- **WHEN** a refund is recorded
- **THEN** no request is sent to the payment provider

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
