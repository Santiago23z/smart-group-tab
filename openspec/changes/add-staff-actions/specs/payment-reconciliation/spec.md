# Spec Delta

## MODIFIED Requirements

### Requirement: Checkouts without a final outcome are checked periodically

The server SHALL check, at a configured interval (default one minute), every reservation for
which a checkout was issued within the last 24 hours and which is neither settled nor released,
by asking Wompi for transactions carrying that reservation's reference. A reservation whose
checkout was never issued SHALL NOT be checked. A reservation SHALL stop being checked once it is
settled or released, or 24 hours after its checkout was issued.

A reservation released by staff — directly, or by cancelling its round — is not a final outcome:
its diner may still be inside the checkout. It SHALL keep being checked until ten minutes after
its hold would have expired, when Wompi no longer accepts the checkout. A reservation released
because Wompi declined it SHALL NOT be checked again.

#### Scenario: The diner closed the phone after paying

- **WHEN** a checkout is approved at Wompi, no webhook arrives, and the diner never returns
- **THEN** within one interval the reservation is settled

#### Scenario: A reservation nobody took to Wompi

- **WHEN** a reservation lapses without a checkout ever being issued for it
- **THEN** Wompi is never asked about it

#### Scenario: An abandoned checkout

- **WHEN** a checkout was issued more than 24 hours ago and Wompi has no final outcome for it
- **THEN** it is no longer checked

#### Scenario: Staff cancelled the round while the diner was paying

- **WHEN** staff cancel a round while one of its diners is inside the checkout, the diner pays,
  and the webhook is lost
- **THEN** the periodic check still finds the payment and it is credited to the table
