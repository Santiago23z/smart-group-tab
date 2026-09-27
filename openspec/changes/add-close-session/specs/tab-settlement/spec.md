# Spec Delta

## Purpose

Defines how a table's tab ends: asking for the bill, what the tab is, paying it in one payment
across every round, writing off what a departed table left unpaid, and closing the table so it
can seat the next party.

## ADDED Requirements

### Requirement: Asking for the bill puts the session into settlement

Any participant of a session, or staff, SHALL be able to ask for the bill. From then on the
session SHALL be in settlement: it SHALL refuse new items and SHALL refuse to close a round,
whatever its status. Asking again SHALL change nothing.

Asking SHALL be refused while the session's draft round has items: those were never sent to the
kitchen, and the diners must either send them or remove them first.

#### Scenario: The table asks for the bill

- **WHEN** a diner asks for the bill at a table with an empty draft round
- **THEN** the session is in settlement and adding an item is refused with reason
  `session_closed`

#### Scenario: Items still in the cart

- **WHEN** a diner asks for the bill while the draft round holds a dish
- **THEN** the request is refused with reason `draft_not_empty`

### Requirement: The tab is what went to the kitchen unpaid

The tab of a session SHALL be every active share of its rounds that were sent to the kitchen
without being collected, and that is neither paid nor written off. Rounds that were collected
before the kitchen, and `hybrid` rounds paid from the prepaid balance, SHALL contribute nothing
to it. The diner app and the kitchen screen SHALL show the tab's total and each participant's
part of it.

#### Scenario: An open tab of three rounds

- **WHEN** an `open_tab` session sent three rounds of 30.000, 20.000 and 10.000 to the kitchen
- **THEN** its tab is 60.000

#### Scenario: Pay-before-order has no tab

- **WHEN** every round of a `pay_before_order` session was collected before the kitchen
- **THEN** its tab is 0

### Requirement: The tab is paid in one payment per person

In settlement a participant SHALL be able to reserve, in one reservation and one checkout,
either every unpaid share of the tab that is theirs, or every unpaid share of the tab. The
reservation SHALL hold those shares exactly as a round reservation does — no share held by two
live reservations, no share paid twice — and SHALL be settled, credited or released by the same
payment outcomes, webhook and reconciliation rules as a round payment.

#### Scenario: One checkout for three rounds

- **WHEN** a diner who ordered in rounds 1, 2 and 3 of an open tab pays "lo mío"
- **THEN** one checkout charges the sum of their shares across the three rounds, and once
  approved those shares are paid

#### Scenario: Two diners cover the rest at once

- **WHEN** two diners reserve "cubrir el resto" of the same tab at the same moment
- **THEN** one of them holds the unpaid shares and the other is refused with nothing available

#### Scenario: A tab payment arrives after its shares were paid by someone else

- **WHEN** an approved tab payment arrives for a lapsed reservation whose shares another diner
  has since paid
- **THEN** it is credited to the session and the session needs staff attention

### Requirement: Staff write off what a departed table left unpaid

When the whole table has left, staff SHALL be able to write off the tab of a session in
settlement, giving a non-empty reason. A write-off SHALL cover every share still unpaid at that
moment and SHALL NOT be possible for selected shares or part of an amount, so that it cannot
serve as a discount. It SHALL be refused while any share of the tab is held by a live
reservation. It SHALL be recorded with its amount, reason and time.

#### Scenario: Nobody came back

- **WHEN** staff write off a session in settlement with 45.000 unpaid, reason "se fueron sin pagar"
- **THEN** the tab is 0, a write-off of 45.000 with that reason is recorded, and nothing was
  charged to anyone

#### Scenario: Someone is paying right now

- **WHEN** staff try to write off a tab while a diner holds a live reservation on it
- **THEN** the request is refused and nothing is written off

### Requirement: A session closes only when nothing is left open

A session SHALL move to `closed` only when it is in settlement, its tab is 0, none of its rounds
is `locked_for_payment` or `requires_staff_attention`, its prepaid balance is 0, it has no
`pending` refund, and it does not need staff attention — closing would make an unresolved alert,
such as an order that never reached the kitchen, disappear. It SHALL close itself when a payment, write-off or staff action makes all of
that true. Staff SHALL be able to ask to close it; the request SHALL be refused with every reason
that still blocks it. Once closed, its table SHALL accept a new session.

#### Scenario: The last payment closes the table

- **WHEN** the last unpaid share of a tab is paid and nothing else blocks closing
- **THEN** the session is `closed` and scanning the table's QR opens a new session

#### Scenario: Credit still on the table

- **WHEN** staff ask to close a session whose tab is 0 but whose prepaid balance is 12.000
- **THEN** the request is refused with reason `balance_left`
