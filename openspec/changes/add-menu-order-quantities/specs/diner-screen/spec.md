# Spec Delta

## ADDED Requirements

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
