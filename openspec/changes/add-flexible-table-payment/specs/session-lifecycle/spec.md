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
sessions already open. After it opens, a session's mode SHALL change only as described in
"A table changes how it pays".

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

When a session changes how it pays, its current `draft` round SHALL take the new mode's
requirement. Rounds already sent to the kitchen SHALL keep the requirement they were created
with. A round in collection when the table switches to a tab SHALL be handled as described in
round-lifecycle "A round in collection goes to the kitchen when its table switches to a tab".

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

#### Scenario: The draft round follows a switch back

- **WHEN** an `open_tab` session with a dish in its draft round switches to paying each round
- **AND** that round is then closed
- **THEN** it moves to `locked_for_payment` and the kitchen is not fired

## ADDED Requirements

### Requirement: A table changes how it pays

Any diner of a session SHALL be able to change how the whole table pays, between
`pay_before_order` and `open_tab`, in either direction, as long as:

- the session is not closed and the bill has not been asked for;
- no share of the session is held by a live reservation (nobody is in the middle of paying);
- no round of the session is `requires_staff_attention`;
- the session is not `hybrid`.

Otherwise the change SHALL be refused with its reason and change nothing. Choosing the mode the
table already has SHALL change nothing. Unpaid shares of rounds already sent to the kitchen stay
on the tab whatever the table switches to, and SHALL be paid when the bill is asked for or before
it, as tab-settlement describes.

#### Scenario: Ana stops paying each round

- **WHEN** Ana, alone at a `pay_before_order` table, has paid round 1 and switches to a tab
- **AND** she orders round 2 and closes it
- **THEN** round 2 goes to the kitchen unpaid
- **AND** when she asks for the bill, the tab holds round 2 only

#### Scenario: Back to paying each round

- **WHEN** an `open_tab` table with round 1 unpaid in the kitchen switches to paying each round
- **AND** it orders and closes round 2
- **THEN** round 2 is collected before the kitchen sees it
- **AND** round 1 is still on the tab

#### Scenario: Not while someone is paying

- **WHEN** a diner holds a live reservation on a share of the table and another diner asks to
  change how the table pays
- **THEN** the change is refused because someone is paying, and nothing changes

#### Scenario: Not after the bill

- **WHEN** the table has asked for the bill and a diner asks to change how it pays
- **THEN** the change is refused and nothing changes

## REMOVED Requirements

### Requirement: A table paying each round can switch to a tab

**Reason**: Replaced by "A table changes how it pays", which works in both directions and also
while a round is in collection.

**Migration**: `switch_to_tab(session, participant)` is replaced by
`set_table_payment(session, participant, mode)`; the diner screen calls the new one.
