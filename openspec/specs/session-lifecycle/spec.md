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

A session that is `closed` or `settling` SHALL refuse new items and SHALL refuse to close a
round.

#### Scenario: Ordering against a settling session

- **WHEN** a participant adds an item to a session that is `settling`
- **THEN** the request is refused with reason `session_closed`

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

A venue SHALL declare an operating mode of `pay_before_order`, `open_tab`, or `hybrid`. When a
session opens, the venue's mode, tip mode, and reservation time-to-live SHALL be copied onto
the session.

Every decision about that session SHALL read the session's copy, never the venue's current
configuration. A venue that changes its configuration SHALL NOT change the rules governing
sessions already open.

#### Scenario: Venue reconfigures mid-service

- **WHEN** a session is open under `hybrid` and the venue switches its default to `open_tab`
- **THEN** that session continues to be governed by `hybrid`
- **AND** the next session opened at that table is governed by `open_tab`

### Requirement: Prepayment requirement per round follows the session's mode

Whether a round must be collected before the kitchen is fired SHALL be resolved from the
session's snapshotted mode and the round's number, and SHALL be fixed on the round when it is
created:

- `pay_before_order`: every round requires prepayment.
- `open_tab`: no round requires prepayment.
- `hybrid`: round 1 requires prepayment; rounds 2 and later do not.

#### Scenario: Hybrid first round

- **WHEN** round 1 of a `hybrid` session is closed
- **THEN** it moves to `locked_for_payment` and the kitchen is not fired

#### Scenario: Open tab never blocks the kitchen

- **WHEN** any round of an `open_tab` session is closed
- **THEN** it is dispatched without collection

### Requirement: Hybrid rounds after the first draw on the prepaid balance

A session SHALL hold a prepaid balance, an integer amount in the currency's minor unit that is
never negative.

When a round that does not require prepayment is closed in a `hybrid` session, the system SHALL
compare the round's total against the session's prepaid balance:

- If the balance covers the total, the balance SHALL be reduced by the total and the round
  SHALL be dispatched.
- If it does not, the round SHALL move to `locked_for_payment` and be collected normally.

#### Scenario: Balance covers the round

- **WHEN** a `hybrid` session holds a prepaid balance of 50.000 and round 2 totals 30.000
- **THEN** the round is dispatched and the balance becomes 20.000

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
