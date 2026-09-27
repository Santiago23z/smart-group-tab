# Spec Delta

## MODIFIED Requirements

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
