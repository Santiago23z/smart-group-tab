# Spec Delta

## ADDED Requirements

### Requirement: Open tables are visible with their tab

The kitchen screen SHALL list every session that is not `closed`, with its table, whether the
bill was asked for, its tab total and each participant's unpaid part, and its prepaid balance.
From that list staff SHALL be able to ask for the bill, write off the tab, and close the table.
Writing off SHALL ask staff to confirm, showing the amount, and SHALL require a reason.

#### Scenario: A table that left without asking

- **WHEN** an `open_tab` table with 45.000 unpaid is still open
- **THEN** it is listed with its tab and staff can ask for the bill, then write it off

#### Scenario: Closing is refused with reasons

- **WHEN** staff tap "Cerrar mesa" on a table that still has a round in collection and credit
- **THEN** the screen says both reasons and the table stays open
