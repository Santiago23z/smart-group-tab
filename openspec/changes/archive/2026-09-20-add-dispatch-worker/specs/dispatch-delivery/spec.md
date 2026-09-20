# Spec Delta

## Purpose

Defines how a dispatch that has been recorded actually reaches the kitchen: how work is claimed,
what is delivered, how failure is retried and when it stops being retried. Recording a dispatch
exactly once is worthless if nothing delivers it, and food that was paid for and never cooked is
the worst failure this system has.

## ADDED Requirements

### Requirement: Pending dispatches are delivered

Every dispatch record SHALL be delivered to a destination configured for its channel. A record
SHALL be considered due when its status is `pending` and its next attempt time has arrived.

Delivery SHALL be performed outside the transaction that recorded the dispatch. No delivery
attempt SHALL be able to roll back a settled payment.

#### Scenario: A recorded dispatch is delivered

- **WHEN** a round is released to the kitchen and its dispatch records are due
- **THEN** each record is delivered to the destination configured for its channel
- **AND** each record becomes `delivered` and carries a delivery timestamp

#### Scenario: Nothing is delivered before it is due

- **WHEN** a dispatch record's next attempt time is in the future
- **THEN** no delivery is attempted for it

### Requirement: Every enqueued channel is delivered

Both channels that a released round enqueues — `kds` and `print` — SHALL be delivered. A channel
SHALL NOT be left permanently unattended.

A destination that is a stand-in for hardware that does not exist yet is still a destination: it
SHALL receive the delivery and the record SHALL reach a terminal state. A record that can never
leave `pending` is indistinguishable from one that is stuck, and destroys the only signal an
outbox exists to give.

#### Scenario: Both channels reach a terminal state

- **WHEN** a round is released to the kitchen
- **THEN** neither its `kds` record nor its `print` record remains `pending` once delivery
  succeeds

### Requirement: Concurrent workers never deliver the same record twice

Claiming a dispatch record SHALL be mutually exclusive, and SHALL remain so for the whole time
that record is being delivered — not merely for the instant it is picked up.

A worker that cannot claim a record SHALL skip it rather than wait for it, so that one slow
destination never stalls a queue another worker could be draining.

#### Scenario: Several workers drain one queue

- **WHEN** several workers claim work at the same instant against the same pending records
- **THEN** each record is delivered once
- **AND** no worker blocks waiting for a record another worker holds

#### Scenario: A second worker arrives mid-delivery

- **WHEN** one worker has claimed a record and its delivery is still in flight
- **AND** another worker looks for due work
- **THEN** that record is not offered to the second worker

### Requirement: A claim is held by a lease that expires on its own

A claimed record SHALL stop being due for a bounded period covering its delivery, and SHALL
become due again by itself once that period passes without an outcome being recorded.

Recovery SHALL NOT depend on any process running on time. A worker that is killed mid-delivery
SHALL NOT strand its record in a state only a separate cleanup process can release: the record
becomes deliverable again through the passage of time alone.

The period SHALL be longer than the maximum time a delivery attempt can take. A lease that can
expire while its own delivery is still in flight re-creates the duplicate it exists to prevent.

#### Scenario: A worker is killed while delivering

- **WHEN** a worker claims a record and is killed before recording an outcome
- **THEN** the record becomes due again once the period has passed
- **AND** no cleanup process was needed to release it

#### Scenario: The lease outlasts the attempt it covers

- **WHEN** a delivery attempt runs for as long as it is permitted to
- **THEN** the record is still not due for any other worker

### Requirement: The delivered payload is a kitchen ticket and carries no money

What is delivered SHALL identify the venue, the table, the round and its number, and SHALL list
the round's active items with their quantity, their name, and who ordered them.

It SHALL NOT contain amounts, balances, shares, payment references, or any other financial
detail. The kitchen needs to know what to cook and for which table; it has no business with the
bill.

Items that were removed from the round SHALL NOT appear.

#### Scenario: A ticket for a table

- **WHEN** a round containing two active items is delivered
- **THEN** the payload names the venue, the table, and the round number
- **AND** lists both items with their quantities and the nickname that ordered each

#### Scenario: A removed item is not cooked

- **WHEN** a round is released after one of its items was removed while it was a draft
- **THEN** that item does not appear in the delivered payload

#### Scenario: No money reaches the kitchen

- **WHEN** any dispatch is delivered
- **THEN** the payload contains no amount, balance, share or payment reference

### Requirement: A failed delivery is retried with growing backoff

When a delivery attempt fails, the record SHALL remain deliverable: its attempt count SHALL be
incremented, its last error SHALL be recorded, and its next attempt SHALL be scheduled further
into the future than the previous one, up to a cap.

A failed attempt SHALL NOT lose the record and SHALL NOT mark it delivered.

#### Scenario: The kitchen display is restarting

- **WHEN** a delivery attempt fails
- **THEN** the record is still `pending`, its attempt count has grown, and its last error is
  recorded
- **AND** its next attempt is scheduled later than the interval that preceded it

#### Scenario: Recovery after failures

- **WHEN** a record that has failed several times is delivered successfully
- **THEN** it becomes `delivered` and is never attempted again

### Requirement: Delivery is at least once, never guaranteed exactly once

The system SHALL NOT claim exactly-once delivery. A worker that delivers successfully and stops
before recording the outcome SHALL re-deliver that record when it resumes.

The pairing of a round and a channel SHALL be usable by the receiving end as an idempotency key,
so that receiving the same ticket twice shows one order.

#### Scenario: The worker dies between delivering and recording

- **WHEN** a delivery succeeds and the worker stops before the record is marked `delivered`
- **THEN** the record is still `pending` and is delivered again when a worker resumes
- **AND** both deliveries carry the same round and channel, so the receiver can recognise the
  repeat

### Requirement: Delivery stops after a bounded number of attempts

After a bounded number of failed attempts a record SHALL become `failed`, retaining its last
error, and SHALL NOT be attempted again automatically.

Retrying forever SHALL NOT be the behavior: a delivery that is permanently broken would stay
indistinguishable from one that is merely slow, and nobody would learn that food which was paid
for is not being cooked.

#### Scenario: A destination that never answers

- **WHEN** a record has failed the maximum number of attempts
- **THEN** it becomes `failed` and carries the last error that caused it
- **AND** no further delivery is attempted for it

#### Scenario: A failed record is not silently forgotten

- **WHEN** a record becomes `failed`
- **THEN** its round and channel remain identifiable so a human can act on it

### Requirement: A worker that is not running is detectable

The absence of a worker SHALL be observable rather than silent. It SHALL be possible to detect
dispatch records that have been waiting beyond a reasonable delivery time, so that a stopped
worker is distinguishable from an idle queue.

#### Scenario: Nobody is draining the queue

- **WHEN** dispatch records have been `pending` well past the time delivery should have taken
- **THEN** that condition is reported rather than passing as healthy
