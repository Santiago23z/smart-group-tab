# Spec Delta

## ADDED Requirements

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
