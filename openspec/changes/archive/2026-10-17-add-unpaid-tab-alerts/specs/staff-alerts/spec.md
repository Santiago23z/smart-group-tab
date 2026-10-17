# Spec Delta

## MODIFIED Requirements

### Requirement: Tables that need a human are listed with their reason

The staff screen SHALL list every session in `requires_staff_attention`, showing its table and
every reason that applies:

- **money not placed**: a payment for the session was credited to its prepaid balance instead of
  being applied, with the credited amount and any refund recorded against it, until refunds
  `completed` against it cover the whole amount;
- **delivery failed**: a dispatch for one of its rounds is `failed`, with the channel and the last
  error;
- **collection stalled**: one of its rounds is in `requires_staff_attention`.

A session in `requires_staff_attention` for which no reason can be derived SHALL still be listed,
with an unknown reason. An alert that cannot explain itself is still an alert.

The staff screen SHALL also list every session that is not `closed` in which some participant has
owed part of the tab for longer than the configured threshold, with the reason **cuenta sin pagar
hace rato**: each such participant's nickname, unpaid amount, and how long it has been unpaid,
counted from when the oldest of their unpaid shares went to the kitchen. This reason SHALL NOT
change the session's state and SHALL NOT count as a reason when deciding whether a flagged session
is clear.

Sessions in any other situation SHALL NOT be listed.

#### Scenario: A late payment

- **WHEN** an approved payment for a lapsed reservation is credited to a session's prepaid balance
- **THEN** that table is listed with reason "money not placed" and the credited amount

#### Scenario: A refund on its way

- **WHEN** a refund for the whole credited amount is recorded but still `pending`
- **THEN** the reason is still listed, showing the refund as pending

#### Scenario: The kitchen never received an order

- **WHEN** a dispatch for a round becomes `failed`
- **THEN** that round's table is listed with reason "delivery failed", the channel and the error

#### Scenario: A healthy table

- **WHEN** a session is `open` and nobody has owed on its tab for longer than the threshold
- **THEN** it is not listed

#### Scenario: Ana has owed for two hours

- **WHEN** at an `open_tab` table Ana's dishes went to the kitchen two hours ago, she has not paid,
  and the threshold is 90 minutes
- **THEN** the table is listed with reason "cuenta sin pagar hace rato", Ana's unpaid amount and
  how long
- **AND** the session stays `open`

#### Scenario: Only who is over the threshold

- **WHEN** Ana's part has been unpaid for two hours and Beto's for ten minutes
- **THEN** the reason names Ana and not Beto

#### Scenario: Paying clears it

- **WHEN** Ana pays her part of the tab
- **THEN** the reason no longer names her, and the table leaves the list if nothing else applies

#### Scenario: It does not keep a flagged table flagged

- **WHEN** a flagged table's only flagging reason is resolved by staff while Ana still owes past the
  threshold
- **THEN** the session leaves `requires_staff_attention`, and the table stays listed only for the
  unpaid tab

### Requirement: Alerts are for staff only and carry no diner payment details

Reading alerts and acknowledging them SHALL require the staff credential. Alerts SHALL NOT expose
payment provider references or participants' payment details. Amounts shown SHALL be limited to
the total credited to the session and, for "cuenta sin pagar hace rato", each listed participant's
unpaid part of the tab.

#### Scenario: Unauthenticated request

- **WHEN** a request for alerts arrives without the staff credential
- **THEN** it is refused with an authentication error

#### Scenario: What an unpaid-tab alert shows

- **WHEN** a table is listed for a long-unpaid tab
- **THEN** it shows nicknames and unpaid amounts, and no payment reference
