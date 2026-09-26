# Spec Delta

## Purpose

Defines the kitchen's side of dispatch: how a ticket delivered by the worker is accepted, shown
once to the kitchen however many times it arrives, and cleared when the food goes out.

## ADDED Requirements

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

The screen SHALL show no amount, balance, share or payment reference.

The screen SHALL refresh on its own; a new ticket SHALL appear without anyone reloading the page.

#### Scenario: Two tables order

- **WHEN** tickets arrive for two tables
- **THEN** both are shown, the older one first, each with its table and items

#### Scenario: A new ticket while the screen is open

- **WHEN** a ticket arrives while the kitchen screen is open
- **THEN** it appears without the page being reloaded

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
