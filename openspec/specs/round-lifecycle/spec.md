# round-lifecycle Specification

## Purpose

Defines the states a round of ordering moves through, what each state permits, and how a cart
that has gone to collection is protected from further mutation. A round is the unit that gets
collected for and fired to the kitchen, so its state is the contract every other part of the
system reads.

## Requirements

### Requirement: Round states

A round SHALL be in exactly one of five states: `draft`, `locked_for_payment`,
`paid_and_dispatched`, `requires_staff_attention`, or `cancelled`.

`draft` is the only state in which the cart is mutable. `paid_and_dispatched` is the terminal
success state and SHALL be reached only once per round. `requires_staff_attention` marks a
round whose collection stalled or received money that could not be placed.

`cancelled` is reserved for staff-initiated cancellation of a round, which is decided but not
yet implemented. No automatic transition SHALL reach it.

A round SHALL carry a dispatch timestamp if and only if it is `paid_and_dispatched`.

#### Scenario: A new round starts mutable

- **WHEN** a round is created for a session
- **THEN** its state is `draft` and its cart accepts new items

#### Scenario: Dispatch timestamp tracks the terminal state

- **WHEN** a round is in any state other than `paid_and_dispatched`
- **THEN** it has no dispatch timestamp
- **AND WHEN** it becomes `paid_and_dispatched`
- **THEN** it has one

### Requirement: Exactly one draft round per session

A session SHALL have at most one round in `draft` at any time. Concurrent attempts to open a
draft round for the same session SHALL result in exactly one round being created.

#### Scenario: Concurrent orders do not open two carts

- **WHEN** several participants at one table add their first item at the same instant
- **THEN** all items land in a single `draft` round

### Requirement: Closing a round freezes its cart

When a round that requires prepayment is closed for collection, it SHALL move from `draft` to
`locked_for_payment`, and its cart SHALL become immutable: no item may be added to it, removed
from it, or have its sharing changed.

A round SHALL NOT be closed while its cart total is zero.

#### Scenario: A locked cart refuses new items

- **WHEN** a round is `locked_for_payment` and a participant orders another item
- **THEN** the item is not added to that round

#### Scenario: An empty round cannot be closed

- **WHEN** a round with no active items is closed for collection
- **THEN** the request is refused with reason `empty_round` and the round stays `draft`

### Requirement: Items ordered during collection overflow into a new round

When a participant orders an item while the session's most recent round is
`locked_for_payment`, the system SHALL open a new round in `draft` and place the item there.
The new round SHALL take the next sequential round number within the session.

This SHALL NOT change the total of the round already in collection, because live reservations
point at that total.

#### Scenario: Ordering during collection

- **WHEN** round 1 is `locked_for_payment` and a participant orders a beer
- **THEN** a round 2 is created in `draft` holding the beer
- **AND** round 1's total is unchanged

### Requirement: Item removal is permitted only while the round is draft

An item SHALL be removable only while its round is `draft`. A removal attempt against a round
in any other state SHALL be refused with reason `round_not_editable`.

Removal SHALL be idempotent: removing an already-removed item SHALL report success without
further effect. Removing an item SHALL discard the shares that item carried, so the shares of
the round continue to sum to the round's total.

The MVP SHALL NOT support discounts or partial quantity reductions; removal of the whole item
is the only reduction.

#### Scenario: Removal after the cart froze

- **WHEN** a participant removes an item belonging to a `locked_for_payment` round
- **THEN** the request is refused with reason `round_not_editable` and the item stays active

#### Scenario: Removing an item already removed

- **WHEN** a participant removes an item that is already voided
- **THEN** the request reports success and nothing changes

### Requirement: Item price and tax are snapshotted

When an item is added to a cart, its unit price and tax rate SHALL be copied from the menu and
never read from the menu again. A later menu price change SHALL NOT move the total of any
round that already contains the item.

#### Scenario: Menu price changes mid-service

- **WHEN** an item is in a round and the venue then changes that product's price
- **THEN** the round's total is unchanged

### Requirement: Full settlement transitions the round and enqueues dispatch

A round in `locked_for_payment` SHALL move to `paid_and_dispatched` when, and only when, every
active share of that round is covered by a settled payment. On that transition the system
SHALL enqueue one dispatch record per delivery channel for the round.

The transition SHALL be an explicit state change made by the code that settles the final
share. It SHALL NOT be produced by a database trigger observing accumulated amounts.

The transition and the enqueue SHALL happen at most once per round, however many times
settlement of the final share is observed.

#### Scenario: The last share settles

- **WHEN** the final unsettled share of a `locked_for_payment` round is paid
- **THEN** the round becomes `paid_and_dispatched` and a dispatch record exists per channel

#### Scenario: A repeated settlement notification

- **WHEN** the payment provider re-delivers the notification that settled the final share
- **THEN** the round stays `paid_and_dispatched` and no additional dispatch record is created

#### Scenario: A partially paid round is not dispatched

- **WHEN** some but not all active shares of a round are settled
- **THEN** the round stays `locked_for_payment` and no dispatch record exists

### Requirement: Money that cannot be placed sends the round to staff

When an approved payment arrives against a round but cannot be applied to the shares it was
meant to cover — because those shares were taken by someone else, or because the amount paid
differs from the amount reserved — the round SHALL move to `requires_staff_attention` if it was
`locked_for_payment`.

The payment SHALL NOT be rejected. It SHALL be recorded and credited to the session.

#### Scenario: Payment arrives for shares already taken

- **WHEN** an approved payment arrives for a reservation whose shares another participant has
  since claimed and paid
- **THEN** the round becomes `requires_staff_attention`
- **AND** the money is recorded rather than refused
