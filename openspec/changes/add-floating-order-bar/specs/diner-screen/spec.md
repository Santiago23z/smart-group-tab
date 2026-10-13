# Spec Delta

## ADDED Requirements

### Requirement: A floating order bar on the menu

While the diner is on the menu, the table's round being built has at least one dish, and no payment
or waiter request occupies the bottom bar, the screen SHALL show a floating bar with the number of
dishes and the round's total, and one button:

- with the diner alone at the table: "Pedir y pagar" at a table paying each round, which closes the
  round as ordered and opens the pay sheet; "Enviar a la cocina" at a table on a tab, which closes
  the round as ordered;
- with others at the table: "Ver pedido", which shows the Cuenta tab from its top.

The bar SHALL leave when the round is closed or emptied, and SHALL never be shown together with the
pay bar.

#### Scenario: Alone, paying each round

- **WHEN** a diner alone at a table paying each round adds a dish and taps "Pedir y pagar" on the
  floating bar
- **THEN** the round is closed and the pay sheet is open with the diner's part

#### Scenario: Alone, on a tab

- **WHEN** a diner alone at a table on a tab adds a dish and taps "Enviar a la cocina"
- **THEN** the round goes to the kitchen and the bar leaves

#### Scenario: With others

- **WHEN** a diner at a table with two diners adds a dish and taps "Ver pedido"
- **THEN** the Cuenta tab is shown, with the ways to close the round

#### Scenario: The pay bar has priority

- **WHEN** a round is in collection and the diner owes their part
- **THEN** the pay bar is shown and the floating order bar is not
