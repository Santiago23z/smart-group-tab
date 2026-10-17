# diner-screen Specification

## Purpose
Defines what the diner's phone shows and offers at the table, beyond the payment and round rules
the other capabilities already enforce on the server.

## Requirements

### Requirement: A diner alone at the table sees no group choices

While the table has exactly one diner, the diner's screen SHALL NOT offer to share a dish, and
SHALL offer one button to close the round instead of a choice between splitting as ordered and
splitting equally. That button SHALL say what happens next: "Pedir y pagar" when the table pays
each round before the kitchen, "Enviar a la cocina" when the table runs a tab.

When a second diner joins, every phone at the table SHALL offer the group choices again on its
next refresh, without anyone reloading the page.

#### Scenario: Alone at the table

- **WHEN** a diner alone at a table adds a dish
- **THEN** the cart shows no "Compartir" button
- **AND** the round can be closed with a single button

#### Scenario: The words follow how the table pays

- **WHEN** a diner alone at a table that pays each round looks at the cart
- **THEN** the button reads "Pedir y pagar"
- **WHEN** a diner alone at a table running a tab looks at the cart
- **THEN** the button reads "Enviar a la cocina"

#### Scenario: Someone joins

- **WHEN** a second diner joins a table where the first diner already has a dish in the cart
- **THEN** both phones show "Compartir" and the two ways to close the round, without a reload

#### Scenario: Closing alone charges what was ordered

- **WHEN** a diner alone closes the round with the single button
- **THEN** the round is split as ordered, and the diner owes exactly what they added

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

### Requirement: The menu shows what the table is ordering

For every dish in the table's round being built, the menu SHALL show under the dish's name how
many units are in the round and the nicknames of who added them. The mark SHALL update on every
phone at the table on its next refresh, without anyone reloading the page. Dishes only in rounds
already closed SHALL NOT be marked.

#### Scenario: A friend already ordered it

- **WHEN** Beto adds a "Botella de ron" and Ana looks at the menu on her phone
- **THEN** the dish shows "En el pedido: 1 · Beto" without Ana reloading

#### Scenario: Sent rounds are not marked

- **WHEN** the round with the bottle is closed
- **THEN** the dish no longer shows the mark

### Requirement: Ordering several of a dish from the menu

Once the diner has at least one unit of a dish in the round being built, the dish's add button SHALL
become a stepper showing how many units the diner has: its plus adds one unit, its minus removes the
diner's most recently added unit of that dish. Each unit SHALL remain a separate item of the round.
The minus SHALL never remove a unit another diner added.

#### Scenario: Two bottles

- **WHEN** Ana taps "+" on "Botella de ron" twice
- **THEN** the stepper shows 2 and the round holds two units, both Ana's

#### Scenario: One back

- **WHEN** Ana has two bottles and taps "−"
- **THEN** the stepper shows 1 and the round holds one of Ana's bottles

#### Scenario: Not someone else's

- **WHEN** Ana has one bottle and Beto has one, and Ana taps "−" twice
- **THEN** Ana has none, Beto's bottle is still in the round, and Ana's button is a plain "+" again
