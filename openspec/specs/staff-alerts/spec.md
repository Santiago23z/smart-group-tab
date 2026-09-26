# staff-alerts Specification

## Purpose
Defines how conditions that need a human at the venue are shown to staff: which tables need
attention and why, and whether the kitchen queue is being drained at all. Read-only: resolving
an alert is a separate staff action.

## Requirements

### Requirement: Tables that need a human are listed with their reason

The staff screen SHALL list every session in `requires_staff_attention`, showing its table and
every reason that applies:

- **money not placed**: a payment for the session was credited to its prepaid balance instead of
  being applied, with the credited amount;
- **delivery failed**: a dispatch for one of its rounds is `failed`, with the channel and the last
  error;
- **collection stalled**: one of its rounds is in `requires_staff_attention` for a reason other
  than the above.

A session in `requires_staff_attention` for which no reason can be derived SHALL still be listed,
with an unknown reason. An alert that cannot explain itself is still an alert.

Sessions in any other state SHALL NOT be listed.

#### Scenario: A late payment

- **WHEN** an approved payment for a lapsed reservation is credited to a session's prepaid balance
- **THEN** that table is listed with reason "money not placed" and the credited amount

#### Scenario: The kitchen never received an order

- **WHEN** a dispatch for a round becomes `failed`
- **THEN** that round's table is listed with reason "delivery failed", the channel and the error

#### Scenario: A healthy table

- **WHEN** a session is `open`
- **THEN** it is not listed

### Requirement: A stopped worker is reported

The staff screen SHALL show a warning when any dispatch record has been `pending` and due for
longer than a configured threshold, with how many and how long the oldest has waited. When no
record exceeds the threshold, the warning SHALL NOT be shown.

#### Scenario: Nobody is draining the queue

- **WHEN** a dispatch record has been due and `pending` longer than the threshold
- **THEN** the staff screen warns that orders are not reaching the kitchen

#### Scenario: A record waiting out its backoff

- **WHEN** a dispatch record is `pending` but its next attempt is still in the future
- **THEN** it does not count towards the warning

### Requirement: Staff acknowledge an alert without resolving it

Staff SHALL be able to acknowledge a listed table. An acknowledged table SHALL remain listed,
marked as acknowledged with when. Acknowledging SHALL NOT change the session, any round, any
dispatch record or any money.

A reason that appears after the acknowledgement SHALL mark the table unacknowledged again, so a
new incident at an acknowledged table is not hidden.

#### Scenario: Staff have seen it

- **WHEN** staff acknowledge a listed table
- **THEN** it stays listed, marked acknowledged
- **AND** its session is still `requires_staff_attention`

#### Scenario: A second incident at the same table

- **WHEN** a table was acknowledged and afterwards one of its dispatches becomes `failed`
- **THEN** the table is shown unacknowledged again

### Requirement: Alerts are for staff only and carry no diner payment details

Reading alerts and acknowledging them SHALL require the staff credential. Alerts SHALL NOT expose
payment provider references or participants' payment details; amounts are shown only as the total
credited to the session.

#### Scenario: Unauthenticated request

- **WHEN** a request for alerts arrives without the staff credential
- **THEN** it is refused with an authentication error
