# staff-actions Specification

## Purpose
Defines the actions staff can take from the kitchen screen to resolve what the alerts report —
refunds of credited money, cancelling or resuming a round, releasing a reservation, retrying a
delivery — who may take them, and how each one is recorded.

## Requirements

### Requirement: Only staff can act

Every staff action SHALL require the staff credential the kitchen screen already uses. A request
without it SHALL be refused and SHALL change nothing. The actions SHALL NOT be reachable by
diners, by the diner app, or by the dispatch credential.

#### Scenario: A diner tries to cancel a round

- **WHEN** a request to cancel a round arrives without the staff credential
- **THEN** it is refused and the round is unchanged

### Requirement: Open collections are visible with their actions

The kitchen screen SHALL list every round that is `locked_for_payment` or
`requires_staff_attention`, with its table, round number, total, outstanding amount and each
live reservation (nickname, amount, when its hold expires). From that list staff SHALL be able to
cancel the round, resume it when it is `requires_staff_attention`, and release any live
reservation. The list SHALL NOT show diner payment details.

#### Scenario: A round waiting for money

- **WHEN** a round is `locked_for_payment` with one live reservation
- **THEN** it is listed with its outstanding amount and that reservation's nickname, amount and
  expiry

### Requirement: Actions that move money or stop an order are confirmed first

Recording a refund and cancelling a round SHALL ask staff to confirm, showing the table, the
amount and the consequence, before anything is sent. The other actions MAY run on one tap.

#### Scenario: Staff change their mind

- **WHEN** staff tap "Cancelar ronda" and then dismiss the confirmation
- **THEN** nothing is sent and the round is unchanged

### Requirement: Every staff action is logged

Every staff action that changes state SHALL be recorded with its kind, its target, the session it
concerns, its details (such as an amount or reason) and when it happened. A refused action SHALL
NOT be logged as taken. The log SHALL NOT be editable through any staff action.

#### Scenario: A refund leaves a trace

- **WHEN** staff record a refund
- **THEN** the log holds one entry with kind refund, the contribution, the amount and the time

### Requirement: An action that no longer applies is refused, not forced

Each action SHALL re-check its preconditions at the moment it runs, under the same locks as the
payment path, and SHALL answer with a reason when they no longer hold — the round was paid
meanwhile, the reservation expired, the delivery already succeeded. The screen SHALL show that
reason and refresh.

#### Scenario: The round was paid while staff were deciding

- **WHEN** staff cancel a round that became `paid_and_dispatched` a moment earlier
- **THEN** the request is refused with a reason and the round stays `paid_and_dispatched`
