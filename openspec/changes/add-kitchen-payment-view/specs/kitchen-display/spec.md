# Spec Delta

## MODIFIED Requirements

### Requirement: The kitchen screen shows what to cook

The kitchen screen SHALL list the active tickets oldest first, each showing the table, the round
number, how long it has been waiting, and each item's quantity, name and the nickname that ordered
it.

Each ticket SHALL also show its round's payment state as words, never as an amount:

- **sin pagar** while some active share of the round is neither paid nor written off;
- **pagado · por llevar** once every active share of the round is paid, or the round was paid from
  the table's prepaid balance;
- **pérdida asumida** once nothing is unpaid and at least one share was written off.

The payment state SHALL be recomputed on every refresh, so a ticket changes state without anyone
reloading the page.

A ticket SHALL show no amount, balance, share or payment reference.

The screen SHALL refresh on its own; a new ticket SHALL appear without anyone reloading the page.

#### Scenario: Two tables order

- **WHEN** tickets arrive for two tables
- **THEN** both are shown, the older one first, each with its table and items

#### Scenario: A new ticket while the screen is open

- **WHEN** a ticket arrives while the kitchen screen is open
- **THEN** it appears without the page being reloaded

#### Scenario: A round collected before the kitchen

- **WHEN** a round of a `pay_before_order` table is fully paid and reaches the kitchen
- **THEN** its ticket shows "pagado · por llevar"

#### Scenario: An open-tab round is paid while its ticket is on screen

- **WHEN** a round of an `open_tab` table reaches the kitchen unpaid
- **THEN** its ticket shows "sin pagar"
- **WHEN** every diner then pays their part of the tab
- **THEN** the same ticket shows "pagado · por llevar" without the page being reloaded

#### Scenario: Half paid is still unpaid

- **WHEN** one of two diners in an open-tab round has paid and the other has not
- **THEN** the ticket shows "sin pagar"
- **AND** the ticket shows no amount

#### Scenario: A table that left

- **WHEN** staff write off a table whose ticket is still on screen
- **THEN** the ticket shows "pérdida asumida"

## ADDED Requirements

### Requirement: The kitchen screen shows today's takings

The kitchen screen SHALL show the money received today: the sum of every payment recorded today,
order and tip together, whatever it paid for, including money that landed as table credit. "Today"
SHALL be the calendar day in Colombia (America/Bogota), from midnight to midnight.

The screen SHALL also show, for the same day:

- how much of it came through Wompi, in cash, and on the card terminal;
- how much of it is tips;
- the refunds marked completed today, as a separate figure that is not subtracted from the total.

A write-off SHALL NOT count as money received. The figure SHALL refresh with the rest of the
screen, and reading it SHALL require the staff credential like the rest of the screen's data.

#### Scenario: Nothing yet

- **WHEN** no payment has been recorded today
- **THEN** the screen shows $0 received today

#### Scenario: Three ways to pay

- **WHEN** today one diner paid $30.000 through Wompi with a $3.000 tip, another paid $20.000 in
  cash, and a third paid $10.000 on the card terminal
- **THEN** the screen shows $63.000 received today
- **AND** $33.000 through Wompi, $20.000 in cash, $10.000 on the card terminal
- **AND** $3.000 of it in tips

#### Scenario: Yesterday does not count

- **WHEN** a payment was recorded at 23:50 yesterday, Colombia time
- **THEN** it is not part of today's figure

#### Scenario: A refund

- **WHEN** a $5.000 refund is marked completed today
- **THEN** the screen shows $5.000 refunded today
- **AND** the money received today is unchanged

#### Scenario: A write-off

- **WHEN** staff write off a $40.000 tab today
- **THEN** the money received today does not change

#### Scenario: Without the staff credential

- **WHEN** the kitchen screen's data is requested without the staff credential
- **THEN** it is refused and no takings are returned
