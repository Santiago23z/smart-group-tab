# Spec Delta

## ADDED Requirements

### Requirement: The menu spreadsheet carries a description per dish

The menu spreadsheet SHALL accept an optional description column, headed `descripcion`,
`descripción` or `description`, in the command-line loader and in the staff upload alike. A
description SHALL be plain text of at most 300 characters after trimming; a longer one SHALL be
reported as an error with its row, and the file SHALL NOT be applied. An empty cell SHALL mean the
dish has no description.

#### Scenario: What comes in the picada

- **WHEN** staff apply a menu whose "Picada para compartir" row has the description "Chorizo,
  morcilla, chicharrón, papa criolla y arepa"
- **THEN** the dish has that description

#### Scenario: Too long

- **WHEN** staff upload a menu where row 3 has a description of 301 characters
- **THEN** they see "fila 3" among the errors, and nothing can be applied

### Requirement: Uploading a menu without descriptions keeps them

Applying a spreadsheet that has no description column SHALL leave every dish's description as it
was. Applying one that has the column SHALL set each listed dish's description to its cell, and
an empty cell SHALL clear it. A dish hidden by an upload SHALL keep its description and show it
again if it returns.

#### Scenario: An old file with prices only

- **WHEN** a dish has a description and staff apply a spreadsheet without the description column
  that changes its price
- **THEN** its price changes and its description stays

#### Scenario: Clearing one

- **WHEN** staff apply a spreadsheet with the description column and an empty cell for a dish
  that had a description
- **THEN** the dish has no description

### Requirement: Diners read the description on the menu

The diner menu SHALL show a dish's description in small text under its name, cut to two lines,
and SHALL show it whole when the diner taps it. The large photo view SHALL show the dish's name and
its full description. A dish without a description SHALL be shown as it is today. The staff Carta
panel SHALL show each dish's description.

#### Scenario: Reading it at the table

- **WHEN** a diner opens the menu and the burger's description is three lines long
- **THEN** the first two lines show under its name, and tapping it shows all three

#### Scenario: Looking at the photo

- **WHEN** a diner opens the large photo of the burger
- **THEN** its name and full description show with it
