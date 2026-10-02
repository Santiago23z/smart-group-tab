# Spec Delta

## ADDED Requirements

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
