# Spec Delta

## MODIFIED Requirements

### Requirement: Operating mode is snapshotted at session open

When a session opens, its operating mode SHALL be the one chosen by the diner who opens it:
`pay_before_order` ("Pagar cada ronda") or `open_tab` ("Abrir cuenta y pagar al final"). When the
opening request states no choice, the venue's configured mode SHALL be used. A choice other than
those two SHALL be refused and open nothing. The venue's tip mode and reservation time-to-live
SHALL be copied onto the session.

A diner joining a session that is already open SHALL follow the session's mode; any choice they
send SHALL be ignored, and the answer SHALL say which mode the table follows.

Every decision about that session SHALL read the session's copy, never the venue's current
configuration. A venue that changes its configuration SHALL NOT change the rules governing
sessions already open. The only change to a session's mode after it opens SHALL be the switch to a
tab described in "A table paying each round can switch to a tab".

#### Scenario: Venue reconfigures mid-service

- **WHEN** a session is open under `hybrid` and the venue switches its default to `open_tab`
- **THEN** that session continues to be governed by `hybrid`
- **AND** the next session opened at that table without a stated choice is governed by `open_tab`

#### Scenario: The first diner opens a tab

- **WHEN** the first diner at a free table joins choosing `open_tab`, at a venue configured for
  `pay_before_order`
- **THEN** the session is `open_tab`
- **AND** its rounds go to the kitchen without collection

#### Scenario: A later diner's choice is ignored

- **WHEN** a session is open under `pay_before_order` and a second diner joins choosing `open_tab`
- **THEN** the second diner joins that session, which stays `pay_before_order`
- **AND** the answer says the table pays each round

#### Scenario: Hybrid cannot be chosen

- **WHEN** a diner opening a table chooses `hybrid`, or any value other than the two choices
- **THEN** the request is refused and no session is opened

### Requirement: Prepayment requirement per round follows the session's mode

Whether a round must be collected before the kitchen is fired SHALL be resolved from the
session's mode and the round's number, and SHALL be fixed on the round when it is created:

- `pay_before_order`: every round requires prepayment.
- `open_tab`: no round requires prepayment.
- `hybrid`: round 1 requires prepayment; rounds 2 and later do not.

When a session switches to a tab, the requirement SHALL be cleared on its current `draft` round;
rounds already closed SHALL keep the requirement they were created with.

#### Scenario: Hybrid first round

- **WHEN** round 1 of a `hybrid` session is closed
- **THEN** it moves to `locked_for_payment` and the kitchen is not fired

#### Scenario: Open tab never blocks the kitchen

- **WHEN** any round of an `open_tab` session is closed
- **THEN** it is dispatched without collection

#### Scenario: The draft round follows a switch

- **WHEN** a `pay_before_order` session with a dish in its draft round switches to a tab
- **AND** that round is then closed
- **THEN** it is dispatched without collection

## ADDED Requirements

### Requirement: Diners see how the table pays before and after joining

Before joining, a diner SHALL be able to learn whether the table is free or already open, and
how an open table pays, without joining and without seeing anyone's nickname, order or amount.
A free table SHALL ask the joining diner to choose how the table pays; an open table SHALL say how
it pays. At the table, every diner's screen SHALL say how the table pays.

#### Scenario: A free table asks

- **WHEN** a diner scans the QR of a table with no open session
- **THEN** the join screen offers "Pagar cada ronda" and "Abrir cuenta y pagar al final"

#### Scenario: An open table tells

- **WHEN** a diner scans the QR of a table whose session pays each round
- **THEN** the join screen says the table pays each round and offers no choice

#### Scenario: Nothing private leaks

- **WHEN** the table's status is requested without joining
- **THEN** the answer carries no nickname, item, amount or session identifier

### Requirement: A table paying each round can switch to a tab

Any diner at a `pay_before_order` session SHALL be able to switch the session to `open_tab`, as
long as the session is not closed, the bill has not been asked for, and no round is
`locked_for_payment` or `requires_staff_attention`. Otherwise the switch SHALL be refused with its
reason and change nothing.

After the switch, rounds closed from then on SHALL go to the kitchen without collection, and the
tab SHALL hold only what went to the kitchen unpaid: rounds paid before the switch SHALL NOT be
charged again. A switch from `open_tab` to paying each round SHALL NOT be offered.

#### Scenario: Ana stops paying each round

- **WHEN** Ana, alone at a `pay_before_order` table, has paid round 1 and switches to a tab
- **AND** she orders round 2 and closes it
- **THEN** round 2 goes to the kitchen unpaid
- **AND** when she asks for the bill, the tab holds round 2 only

#### Scenario: Not while a round is being collected

- **WHEN** a round of the table is `locked_for_payment` and a diner asks to switch to a tab
- **THEN** the switch is refused because a round is in collection, and the session stays
  `pay_before_order`

#### Scenario: Not after the bill

- **WHEN** the table has asked for the bill and a diner asks to switch
- **THEN** the switch is refused and nothing changes

#### Scenario: Only one way

- **WHEN** a diner at an `open_tab` table asks to switch
- **THEN** the switch is refused and nothing changes
