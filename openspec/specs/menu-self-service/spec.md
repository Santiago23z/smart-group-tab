# menu-self-service Specification

## Purpose
Defines the minimal menu self-service a venue has from the staff screen: replacing its menu from
a spreadsheet with a preview first, and marking dishes sold out during service.

## Requirements

### Requirement: A venue uploads its menu with a preview first

With the staff credential, staff SHALL be able to upload a menu spreadsheet for a venue using the
same template and validation as the command-line loader. Before anything is written they SHALL
see either every error with its row, or the dishes that will be added, updated and hidden. Only
an explicit apply SHALL write it, in one step; a file with errors SHALL never be applied. An
upload SHALL NOT change the venue's tables or their QR codes.

#### Scenario: Preview of a valid menu

- **WHEN** staff upload a menu that adds one dish, changes a price and drops another dish
- **THEN** the preview lists one added, one updated and one hidden, and the menu is unchanged
  until they apply it

#### Scenario: A file with mistakes

- **WHEN** staff upload a menu where row 4 has the price "doce mil"
- **THEN** they see "fila 4" with that price among the errors, and nothing can be applied

#### Scenario: Tables are untouched

- **WHEN** a menu is applied
- **THEN** every table of the venue keeps its label, state and QR code

### Requirement: Staff mark a dish sold out, and back

Staff SHALL be able to mark any dish of a venue sold out, and available again. A sold-out dish
SHALL NOT appear in the diner menu and SHALL be refused if someone tries to add it, with reason
`product_unavailable`. Items already in a cart SHALL keep their dish and price.

#### Scenario: The ceviche ran out

- **WHEN** staff mark "Ceviche de camarón" sold out
- **THEN** it disappears from every diner's menu on the next refresh and adding it is refused

#### Scenario: Back in stock

- **WHEN** staff mark it available again
- **THEN** it is back in the diner menu

### Requirement: Uploading the menu keeps what is sold out

Sold out SHALL be independent of being on the menu. Applying a menu SHALL NOT make a sold-out dish
available again, and a dish hidden because it left the menu SHALL stay hidden however it is
marked.

#### Scenario: A price change mid-service

- **WHEN** a dish is sold out and staff apply a menu that still lists it with a new price
- **THEN** its price changes and it stays sold out

### Requirement: Menu changes are scoped to one venue and logged

Every menu request SHALL name its venue; a dish that does not belong to that venue SHALL be
refused. When the staff credential can act on more than one venue, the staff screen SHALL ask
which one before showing or changing a menu. Every applied upload and every sold-out change SHALL
be written to the staff action log.

#### Scenario: A dish from another venue

- **WHEN** a sold-out request names venue A and a dish of venue B
- **THEN** it is refused and nothing changes

#### Scenario: Reading back what changed

- **WHEN** staff applied a menu and marked two dishes sold out
- **THEN** the action log holds one upload entry with its counts and two sold-out entries

### Requirement: Staff attach one photo per dish

With the staff credential, staff SHALL be able to attach a photo to a dish of a venue, replace it,
and remove it. The image SHALL be reduced on the staff device before it is sent, to a list size
and a larger size; the server SHALL accept only JPEG, PNG or WebP of a bounded size and SHALL
refuse a dish of another venue. Each change SHALL be written to the staff action log.

#### Scenario: A photo for the ceviche

- **WHEN** staff pick a 4 MB phone photo for "Ceviche de camarón" and save it
- **THEN** a small and a larger version are stored, each well under 1 MB, and the dish shows the
  photo in the Carta panel

#### Scenario: Not an image

- **WHEN** a request sends a file that is not JPEG, PNG or WebP, or is larger than the limit
- **THEN** it is refused and the dish keeps its previous photo

#### Scenario: Removing it

- **WHEN** staff remove a dish's photo
- **THEN** the dish has no photo and the diner menu shows it as text

### Requirement: Diners see the photo without slowing the menu

The diner menu SHALL show a dish's small photo next to it, loading it only when it scrolls into
view, and SHALL open the larger photo when it is tapped. A dish without a photo SHALL be shown
as it is today. A photo SHALL be served from an address that changes when the photo changes,
cached by the phone, so it is downloaded once and never shown stale. The menu SHALL NOT be
redrawn while it has not changed.

#### Scenario: Bad wifi in the bar

- **WHEN** a diner opens a menu of 30 dishes with photos
- **THEN** only the small photos in view are downloaded, and none is downloaded again while the
  menu stays open

#### Scenario: The photo was replaced

- **WHEN** staff replace a dish's photo while a diner has the menu open
- **THEN** the diner sees the new photo on the next refresh, never the old one from cache

### Requirement: Uploading the menu keeps photos

Applying a menu spreadsheet SHALL NOT add, change or remove any photo. A dish that stays on the
menu keeps its photo; a dish hidden by an upload keeps it too, and shows it again if it returns.

#### Scenario: A price change

- **WHEN** staff apply a menu that changes the price of a dish with a photo
- **THEN** the dish keeps its photo
