# Spec Delta

## ADDED Requirements

### Requirement: Deliveries carry a credential the receiver can verify

Every delivery SHALL carry the configured dispatch credential. The worker SHALL refuse to start
without one: a worker that delivers unauthenticated tickets either fails every delivery or
teaches the receiver to accept anyone.

A delivery refused by the receiver as unauthenticated SHALL be treated as a failed attempt,
retried and eventually failed like any other refusal, never as delivered.

#### Scenario: The receiver verifies the sender

- **WHEN** a dispatch record is delivered
- **THEN** the delivery carries the configured credential

#### Scenario: A credential mismatch

- **WHEN** the receiver refuses a delivery as unauthenticated
- **THEN** the record stays `pending` with its attempt count grown and the refusal as its last
  error
