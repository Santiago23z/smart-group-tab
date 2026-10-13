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
