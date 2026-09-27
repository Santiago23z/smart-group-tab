# Spec Delta

## MODIFIED Requirements

### Requirement: Round states

A round SHALL be in exactly one of five states: `draft`, `locked_for_payment`,
`paid_and_dispatched`, `requires_staff_attention`, or `cancelled`.

`draft` is the only state in which the cart is mutable. `paid_and_dispatched` is the terminal
success state and SHALL be reached only once per round. `requires_staff_attention` marks a
round whose collection stalled or received money that could not be placed.

`cancelled` is terminal and SHALL be reached only by a staff action. No automatic transition
SHALL reach it.

A round SHALL carry a dispatch timestamp if and only if it is `paid_and_dispatched`.

#### Scenario: A new round starts mutable

- **WHEN** a round is created for a session
- **THEN** its state is `draft` and its cart accepts new items

#### Scenario: Dispatch timestamp tracks the terminal state

- **WHEN** a round is in any state other than `paid_and_dispatched`
- **THEN** it has no dispatch timestamp
- **AND WHEN** it becomes `paid_and_dispatched`
- **THEN** it has one

### Requirement: Money that cannot be placed sends the round to staff

When an approved payment arrives against a round but cannot be applied to the shares it was
meant to cover — because those shares were taken by someone else, because the amount paid
differs from the amount reserved, or because the round was cancelled — the payment SHALL be
recorded and credited to the session, and the round SHALL move to `requires_staff_attention` if
it was `locked_for_payment`. A cancelled round SHALL stay `cancelled`.

The payment SHALL NOT be rejected.

#### Scenario: Payment arrives for shares already taken

- **WHEN** an approved payment arrives for a reservation whose shares another participant has
  since claimed and paid
- **THEN** the round becomes `requires_staff_attention`
- **AND** the money is recorded rather than refused

#### Scenario: Payment arrives for a cancelled round

- **WHEN** an approved payment arrives for a reservation of a round staff cancelled
- **THEN** the money is credited to the session and the session needs staff attention
- **AND** the round stays `cancelled` and nothing is sent to the kitchen

## ADDED Requirements

### Requirement: Staff can cancel a round nobody paid for

Staff SHALL be able to cancel a round that is `locked_for_payment` or `requires_staff_attention`
and has no money applied to it. Cancelling SHALL release its live reservations and SHALL NOT
enqueue anything for the kitchen. A round in any other state, or with money applied to it, SHALL
NOT be cancellable.

#### Scenario: The table left without paying

- **WHEN** staff cancel a `locked_for_payment` round with no payments and one live reservation
- **THEN** the round becomes `cancelled` and the reservation is released

#### Scenario: Part of the round is paid

- **WHEN** staff try to cancel a round one diner has already paid part of
- **THEN** the request is refused and the round is unchanged

### Requirement: Staff can resume a stalled round

Staff SHALL be able to move a round from `requires_staff_attention` back to
`locked_for_payment`, so its remaining shares can be collected. Shares already paid stay paid.
If every share is already paid, resuming SHALL release the round to the kitchen exactly as the
final payment would have.

#### Scenario: After an amount mismatch

- **WHEN** a round went to `requires_staff_attention` because a payment did not match its
  reservation, and staff resume it
- **THEN** it is `locked_for_payment` and diners can pay what is still outstanding
