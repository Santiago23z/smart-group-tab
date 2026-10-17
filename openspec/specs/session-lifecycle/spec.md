# session-lifecycle Specification

## Purpose

Defines the life of a tab bound to a physical table: how it opens from a QR scan, the operating
rules it is bound to for its whole life, and the pool of prepaid funds it holds. The session is
what makes several rounds add up to one bill.

## Requirements

### Requirement: Session states

A session SHALL be in exactly one of four states: `open`, `settling`,
`requires_staff_attention`, or `closed`.

A session SHALL carry a closing timestamp if and only if it is `closed`.

Whether the bill was asked for SHALL be recorded apart from the state, because a session in
settlement can also need staff attention. A session that is `closed`, or for which the bill was
asked for, SHALL refuse new items and SHALL refuse to close a round, whatever its state. A
session for which the bill was asked for SHALL be `settling` unless it needs staff attention or
is `closed`.

#### Scenario: Ordering against a settling session

- **WHEN** a participant adds an item to a session that is `settling`
- **THEN** the request is refused with reason `session_closed`

#### Scenario: A late payment during settlement

- **WHEN** money is credited to a session in settlement and it becomes
  `requires_staff_attention`
- **THEN** adding an item is still refused

#### Scenario: Closing timestamp tracks the terminal state

- **WHEN** a session is in any state other than `closed`
- **THEN** it has no closing timestamp

### Requirement: One live session per table

A physical table SHALL host at most one session in a live state (`open`, `settling`, or
`requires_staff_attention`) at a time. Concurrent QR scans of the same table SHALL join the
same session rather than opening several.

#### Scenario: Several phones scan one QR simultaneously

- **WHEN** ten phones scan the same table QR at the same instant
- **THEN** one session exists for that table and all ten participants belong to it

#### Scenario: A new table gets a new session

- **WHEN** the first phone scans the QR of a table with no live session
- **THEN** a session is opened for that table

### Requirement: Identity is a nickname within the session

A participant SHALL join by supplying a nickname and nothing else — no account, no email, no
verification. A nickname SHALL be unique within its session; a request using a nickname already
taken in that session SHALL be refused with reason `nickname_taken` so the caller can ask
again.

Phone capture, if it happens at all, SHALL occur only after payment.

#### Scenario: Duplicate nickname at one table

- **WHEN** a second guest tries to join a session using a nickname already present
- **THEN** the request is refused with reason `nickname_taken` and no participant is created

#### Scenario: Joining needs only a nickname

- **WHEN** a guest scans the QR and supplies a nickname
- **THEN** they are a participant in the session with no further credentials

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

### Requirement: Hybrid rounds after the first draw on the prepaid balance

A session SHALL hold a prepaid balance, an integer amount in the currency's minor unit that is
never negative.

When a round that does not require prepayment is closed in a `hybrid` session, the system SHALL
compare the round's total against the session's prepaid balance:

- If the balance covers the total, the balance SHALL be reduced by the total, the round SHALL be
  recorded as paid from the balance, and it SHALL be dispatched. It SHALL never be part of the
  tab.
- If it does not, the round SHALL move to `locked_for_payment` and be collected normally.

#### Scenario: Balance covers the round

- **WHEN** a `hybrid` session holds a prepaid balance of 50.000 and round 2 totals 30.000
- **THEN** the round is dispatched, the balance becomes 20.000, and the round adds nothing to the
  tab

#### Scenario: Balance falls short

- **WHEN** a `hybrid` session holds a prepaid balance of 10.000 and round 2 totals 30.000
- **THEN** the round moves to `locked_for_payment` and the balance is unchanged

### Requirement: Unplaceable money is credited to the session and flagged

Money that really moved SHALL never be rejected. When an approved payment cannot be applied to
the shares it was reserved against, its full amount SHALL be added to the session's prepaid
balance, recorded in the ledger as credited rather than applied, and the session SHALL move to
`requires_staff_attention` unless it is already `closed`.

This SHALL apply equally to a payment arriving after its reservation lapsed, a duplicate
payment for one reservation, and a payment whose amount differs from the amount reserved.

#### Scenario: Late payment against a lapsed hold

- **WHEN** an approved payment arrives for a reservation whose hold expired and whose shares
  another participant has since paid
- **THEN** the amount is added to the session's prepaid balance
- **AND** the session becomes `requires_staff_attention`

#### Scenario: The diner paid twice from two open checkouts

- **WHEN** a second approved payment arrives for a reservation already settled
- **THEN** both payments are recorded and the second is credited to the prepaid balance
- **AND** the session becomes `requires_staff_attention`

#### Scenario: A closed session still absorbs late money

- **WHEN** unplaceable money arrives for a session that is `closed`
- **THEN** the amount is still credited to the prepaid balance
- **AND** the session stays `closed`

### Requirement: Food that could not be sent to the kitchen flags the session

When a dispatch for a round reaches a terminal failure, the session that round belongs to SHALL
move to `requires_staff_attention` unless it is already `closed`.

The diners have paid and the kitchen never received the order, which no amount of retrying will
now fix. This is the same class of incident as money that could not be placed: a human at the
venue has to look at this table. A failed record that nothing surfaces is not an alert.

The round SHALL NOT be moved out of `paid_and_dispatched`. It was paid and it was released; the
failure is in delivery, and rewriting the round's state would make the ledger describe something
that did not happen.

#### Scenario: The kitchen display never accepted the order

- **WHEN** a dispatch for a round exhausts its attempts and becomes `failed`
- **THEN** the round's session moves to `requires_staff_attention`
- **AND** the round stays `paid_and_dispatched` with its dispatch timestamp intact

#### Scenario: A closed session is not reopened by a late failure

- **WHEN** a dispatch reaches terminal failure for a round whose session is already `closed`
- **THEN** the session stays `closed`

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
