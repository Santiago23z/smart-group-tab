# Spec Delta

## ADDED Requirements

### Requirement: A diner's confirmed payment is celebrated on their phone

When a payment made by a diner is confirmed, that diner's phone SHALL show a celebration: a
check mark, the words "¡Pagado!" and the amount of that payment, tip included. It SHALL appear
however the payment was confirmed — Wompi on the diner's return, a Wompi confirmation that
arrives later while the diner is at the table, the simulated payment, or a cash or card-terminal
payment the staff register for that diner. It SHALL appear only on the phone of the diner who
paid, and only once per payment: reloading the page or opening the table again SHALL NOT show
it again. A diner joining a table SHALL NOT see a celebration for payments made before.

The celebration SHALL close by itself after a few seconds or when tapped, and SHALL NOT block
the screen beyond that. Where the phone supports it, it SHALL vibrate briefly. When the phone
asks for reduced motion, it SHALL appear without movement.

On returning from Wompi with an approved payment, the celebration SHALL replace the "Pago
aprobado" message; declined, pending and unplaceable payments keep their messages.

#### Scenario: Paying through Wompi

- **WHEN** Ana pays her part through Wompi and comes back to the table with the payment approved
- **THEN** Ana's phone shows "¡Pagado!" with the amount she paid
- **AND** Beto's phone at the same table shows no celebration

#### Scenario: The confirmation arrives later

- **WHEN** Ana's payment was still pending when she came back and is confirmed a minute later
- **THEN** her phone shows the celebration on its next refresh

#### Scenario: Paid in cash to the waiter

- **WHEN** staff register that Ana paid her part in cash
- **THEN** Ana's phone shows the celebration with that amount

#### Scenario: Only once

- **WHEN** Ana has seen the celebration for a payment and reloads the page
- **THEN** no celebration is shown again

#### Scenario: Reduced motion

- **WHEN** Ana's phone asks for reduced motion and her payment is confirmed
- **THEN** the celebration appears without the check drawing or anything moving
