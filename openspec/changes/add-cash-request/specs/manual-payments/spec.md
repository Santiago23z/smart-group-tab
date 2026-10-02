# Spec Delta

## ADDED Requirements

### Requirement: A diner asks to pay in cash or on the card terminal

From the app a diner SHALL be able to ask to pay their own unpaid part, or everything still
unpaid, in cash or on the card terminal: of the round being collected, or of the tab once the bill
was asked for. The request SHALL move no money and hold no shares. A diner SHALL have at most one
open request; a new one replaces it. The diner SHALL see their open request and be able to
cancel it.

#### Scenario: Paying their part in cash

- **WHEN** a diner whose part of the round is 34.000 asks to pay it in cash
- **THEN** the request is open for 34.000 in cash, nothing is paid and nothing is held

#### Scenario: Changing their mind

- **WHEN** the diner cancels the request
- **THEN** it is no longer shown anywhere

### Requirement: Staff see the request and collect it in one step

The staff screen SHALL list open requests at the top, with table, nickname, amount still unpaid,
method and how long ago it was made. Collecting from a request SHALL open the cash dialog already
set to that person (or the rest) and that method. Staff SHALL be able to dismiss a request.

#### Scenario: The waiter collects it

- **WHEN** staff tap "Cobrar en caja" on a cash request from Ana for 34.000 and confirm
- **THEN** Ana's part is paid in cash and the request is gone

### Requirement: A request ends when its part is paid

A request SHALL stop being listed as soon as the part it names has nothing left unpaid, whatever
paid it — Wompi, cash, the card terminal, or another diner covering the rest — and its listed
amount SHALL always be what is still unpaid.

#### Scenario: Paid in Wompi after all

- **WHEN** a diner asked to pay in cash and then pays the same part in Wompi
- **THEN** the request disappears from the staff screen without anyone touching it
