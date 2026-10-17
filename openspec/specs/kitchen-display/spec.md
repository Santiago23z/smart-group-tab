# kitchen-display Specification

## Purpose
Defines the kitchen's side of dispatch: how a ticket delivered by the worker is accepted, shown
once to the kitchen however many times it arrives, and cleared when the food goes out.

## Requirements

### Requirement: The kitchen display accepts tickets on both channels

The kitchen display SHALL accept deliveries for the `kds` channel and for the `print` channel.
A delivery it has stored or acknowledged SHALL be answered with success, so the dispatch record
reaches `delivered`.

The `print` channel SHALL be acknowledged without being shown. It is a stand-in for a printer that
does not exist yet, and still counts as a destination.

A delivery that is malformed or does not identify its round and channel SHALL be refused with a
client error and SHALL NOT be stored.

#### Scenario: A kitchen ticket arrives

- **WHEN** an authenticated `kds` delivery arrives for a round
- **THEN** it is answered with success
- **AND** the ticket appears on the kitchen screen

#### Scenario: The print channel has somewhere to go

- **WHEN** an authenticated `print` delivery arrives
- **THEN** it is answered with success and nothing new appears on the kitchen screen

#### Scenario: A malformed delivery

- **WHEN** a delivery arrives whose body is not a ticket or that lacks its round or channel
- **THEN** it is refused with a client error and nothing is stored

### Requirement: Only the dispatch worker can put a ticket on the screen

The kitchen display SHALL refuse any delivery that does not carry the configured dispatch
credential, answering with an authentication error and storing nothing.

The kitchen display SHALL refuse to start without a configured dispatch credential. A kitchen
screen that accepts tickets from anyone lets anyone on the network have food cooked that was never
paid for.

#### Scenario: A forged ticket

- **WHEN** a delivery arrives without the credential, or with a wrong one
- **THEN** it is refused with an authentication error
- **AND** nothing appears on the kitchen screen

### Requirement: A repeated delivery shows one order

The pair of round and channel SHALL be the kitchen display's idempotency key. Receiving the same
round on the same channel more than once SHALL leave exactly one ticket, SHALL answer every
repeat with success, and SHALL NOT reopen a ticket already marked done.

#### Scenario: The worker re-delivers after a crash

- **WHEN** the same round arrives twice on the `kds` channel
- **THEN** the kitchen screen shows one ticket for it
- **AND** both deliveries are answered with success

#### Scenario: A repeat after the food went out

- **WHEN** a ticket has been marked done and the same round arrives again
- **THEN** it stays done and does not reappear on the active list

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

### Requirement: Staff mark a ticket done

Staff SHALL be able to mark an active ticket done. A done ticket SHALL leave the active list and
record when it was done. Marking a ticket done SHALL be idempotent and SHALL NOT change the round,
the session, or any dispatch record.

#### Scenario: The food goes out

- **WHEN** staff mark a ticket done
- **THEN** it leaves the active list
- **AND** the round stays `paid_and_dispatched`

### Requirement: The kitchen screen is for staff only

Reading the kitchen screen's data and marking tickets done SHALL require the configured staff
credential. A request without it SHALL be refused with an authentication error.

The kitchen display SHALL refuse to start without a configured staff credential.

#### Scenario: A diner opens the kitchen URL

- **WHEN** a request for the kitchen screen's data arrives without the staff credential
- **THEN** it is refused with an authentication error and returns no tickets

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

### Requirement: Identical dishes are shown together on a ticket

On a kitchen ticket, units of the same dish ordered by the same diner in a round SHALL be shown as
one line with their total quantity. Units of the same dish ordered by different diners SHALL stay
on separate lines, each with its own nickname.

#### Scenario: Two bottles for Ana

- **WHEN** a round holds two units of "Botella de ron" added by Ana
- **THEN** the ticket shows one line "2× Botella de ron" with Ana's nickname

#### Scenario: One each

- **WHEN** a round holds one "Botella de ron" by Ana and one by Beto
- **THEN** the ticket shows two lines, "1×" for Ana and "1×" for Beto
