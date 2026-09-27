# Spec Delta

## ADDED Requirements

### Requirement: Staff can retry a failed delivery

Staff SHALL be able to put a `failed` dispatch back to `pending`, due immediately and with a
fresh attempt budget. It SHALL then be delivered under every rule that applies to any pending
dispatch, including the bounded number of attempts. Only `failed` dispatches SHALL be retryable.

#### Scenario: The kitchen screen was switched off

- **WHEN** a dispatch failed while the kitchen display was down, and staff retry it after
  switching it back on
- **THEN** it is delivered and becomes `delivered`

#### Scenario: Retrying a delivered record

- **WHEN** staff try to retry a dispatch that is `delivered`
- **THEN** the request is refused and nothing is re-sent
