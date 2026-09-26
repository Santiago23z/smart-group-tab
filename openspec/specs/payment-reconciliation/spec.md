# payment-reconciliation Specification

## Purpose
Defines how a Wompi payment outcome reaches the ledger when the webhook does not: by asking
Wompi directly, when the diner returns from the checkout and by periodic check, without ever
recording the same payment twice.

## Requirements

### Requirement: An outcome learned from Wompi settles exactly like its webhook

When the server learns a transaction's final outcome by asking Wompi, it SHALL settle it with the
same rules and the same idempotency identity as the webhook for that transaction and status. The
ledger SHALL hold one record of that outcome no matter how many times, or by which route, it is
observed.

A transaction still `PENDING` at Wompi SHALL NOT change the ledger. `APPROVED` SHALL settle or
credit exactly as an approved webhook does; `DECLINED`, `VOIDED` and `ERROR` SHALL release the
hold exactly as a declined webhook does.

The stored record SHALL show that the outcome came from a lookup rather than a signed webhook.

#### Scenario: The webhook never arrives

- **WHEN** a transaction is approved at Wompi and no webhook is delivered
- **AND** the server looks the transaction up
- **THEN** the reservation is settled and, if it completes the round, the round is dispatched

#### Scenario: The webhook arrives after the lookup

- **WHEN** an approved transaction was settled by a lookup
- **AND** its webhook is delivered later
- **THEN** the webhook is recognised as a duplicate and nothing else is recorded

#### Scenario: The lookup runs after the webhook

- **WHEN** an approved transaction was settled by its webhook
- **AND** the server looks the same transaction up
- **THEN** nothing else is recorded

#### Scenario: Late money found by a lookup

- **WHEN** a lookup finds an approved transaction for a reservation whose shares another
  participant has since paid
- **THEN** the amount is credited to the session's prepaid balance and the session is flagged for
  staff, as for a late webhook

#### Scenario: Still in flight

- **WHEN** a lookup finds the transaction `PENDING`
- **THEN** the ledger is unchanged and the reservation remains due for later checks

### Requirement: Only Wompi's answer can settle a payment

A lookup SHALL take its outcome, amount and reference only from Wompi's authenticated response,
never from anything the diner's device sends. The device MAY name a transaction id to check; an
id Wompi does not know, or whose reference matches no reservation, SHALL settle nothing.

#### Scenario: A forged return

- **WHEN** a device asks the server to check a transaction id that Wompi does not know
- **THEN** nothing is settled and the device is told the payment was not found

#### Scenario: A real transaction from another merchant flow

- **WHEN** a device names a real transaction whose reference matches no reservation
- **THEN** nothing is settled

### Requirement: The diner's return is checked at once

A checkout SHALL send the diner back to their table page when Wompi finishes, unless the page was
reached through an IP address or `localhost`: Wompi refuses the whole checkout for such a return
address, so the checkout SHALL then carry no return address and the periodic check SHALL cover
the payment. On return, the page
SHALL ask the server to check the transaction Wompi reports, and SHALL show the outcome: paid,
declined, or still processing. It SHALL NOT offer to pay a reservation that the check has just
settled.

#### Scenario: Back from an approved payment with no webhook yet

- **WHEN** the diner returns from an approved checkout before any webhook arrived
- **THEN** the page shows the payment as done and no longer offers that reservation for payment

#### Scenario: The diner reached the table by IP address

- **WHEN** the diner's page was loaded from an IP address
- **THEN** the checkout still opens, with no return address

#### Scenario: Back from a declined payment

- **WHEN** the diner returns from a declined checkout
- **THEN** the page says the payment was declined and the diner can try again

#### Scenario: Back while the bank is still deciding

- **WHEN** the diner returns while the transaction is `PENDING`
- **THEN** the page says the payment is still being processed

### Requirement: Checkouts without a final outcome are checked periodically

The server SHALL check, at a configured interval (default one minute), every reservation for
which a checkout was issued within the last 24 hours and which is neither settled nor released,
by asking Wompi for transactions carrying that reservation's reference. A reservation whose
checkout was never issued SHALL NOT be checked. A reservation SHALL stop being checked once it is
settled or released, or 24 hours after its checkout was issued.

#### Scenario: The diner closed the phone after paying

- **WHEN** a checkout is approved at Wompi, no webhook arrives, and the diner never returns
- **THEN** within one interval the reservation is settled

#### Scenario: A reservation nobody took to Wompi

- **WHEN** a reservation lapses without a checkout ever being issued for it
- **THEN** Wompi is never asked about it

#### Scenario: An abandoned checkout

- **WHEN** a checkout was issued more than 24 hours ago and Wompi has no final outcome for it
- **THEN** it is no longer checked

### Requirement: Reconciliation is off without the private key, and says so

Looking transactions up SHALL require the merchant's private key. Without it, the server SHALL
still run and take payments by webhook, SHALL NOT attempt any lookup, and SHALL state at startup
that reconciliation is disabled. On return, the page SHALL then wait for the webhook as before.
The private key SHALL NOT be sent to the diner's device or written to logs.

#### Scenario: No private key configured

- **WHEN** the server starts without a private key
- **THEN** it reports that reconciliation is disabled and makes no calls to Wompi's API

#### Scenario: Wompi is unreachable

- **WHEN** a lookup fails because Wompi does not answer or answers with an error
- **THEN** the ledger is unchanged and the reservation is checked again at the next interval
