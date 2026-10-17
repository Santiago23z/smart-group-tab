# Spec Delta

## ADDED Requirements

### Requirement: Diners change how the table pays from their phone

The diner's screen SHALL offer to change how the table pays whenever the table may change it: to
"pagar al final" at a table paying each round, and to "pagar cada ronda" at a table running a tab.
Each change SHALL ask for a short confirmation that says it applies to the whole table. A refused
change SHALL show its reason. Every phone at the table SHALL show the new mode on its next refresh.

When a round is in collection and the diner opens the pay sheet, the sheet SHALL also offer
"Seguir pidiendo y pagar todo al final", which switches the table to a tab and sends the round to
the kitchen.

#### Scenario: From the pay sheet

- **WHEN** Ana opens the pay sheet for a round in collection and taps "Seguir pidiendo y pagar todo
  al final", then confirms
- **THEN** the round shows as sent to the kitchen, and the table shows it pays at the end

#### Scenario: Back to paying each round

- **WHEN** a diner at a tab table switches to paying each round and confirms
- **THEN** the table shows it pays each round, and the next round asks for payment before the
  kitchen

### Requirement: On a tab, a diner can pay their part before the bill

At an `open_tab` table that has not asked for the bill, a diner who owes something on the tab SHALL
see their part and be able to pay it, while the table keeps ordering.

#### Scenario: Carla leaves early

- **WHEN** Carla owes 20.000 on the tab and taps "Pagar lo mío" before the bill
- **THEN** she pays 20.000, and the others can keep ordering
