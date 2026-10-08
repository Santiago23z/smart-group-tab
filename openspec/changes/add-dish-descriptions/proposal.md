# Proposal

## Why

With photos in place, the diner menu still says nothing about a dish beyond its name and price:
what comes in the "Picada para compartir", what the burger is made of. Diners ask the waiter,
which is the friction the app exists to remove. A bar already writes these lines on its printed
menu, so it can put them in the same spreadsheet it uploads today.

## What Changes

- The menu spreadsheet gains an optional `descripcion` column (`description` also accepted), read
  by the same parser and validation used by `npm run venue:load` and the staff upload. A
  description longer than 300 characters is an error with its row, like any other.
- Each dish stores its description. Uploading a file **without** the column leaves existing
  descriptions as they are; a file **with** the column sets them, and an empty cell clears one.
- The diner menu shows the description in small text under the dish name, cut to two lines; tapping
  it shows it whole. The large photo view shows the dish name and its full description.
- The staff Carta panel shows each dish's description, so staff can check what the upload wrote.
- `CLAUDE.md` scope line changes from "No per-dish editor, descriptions or modifiers" to allow a
  description from the spreadsheet only. Still no per-dish editor and no modifiers.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `menu-self-service`: the spreadsheet carries an optional description per dish, the upload keeps
  descriptions when the column is absent, and diners see the description on the menu.

## Impact

- **Database:** one migration adding a nullable `description` text column to `products`, with a
  length check.
- **Code:** `src/admin/venue.mjs` (`parseMenu`, `loadMenu`), diner state in `src/api/server.mjs`,
  KDS menu listing in `src/kds/app.mjs`, `public/app.js` / `style.css` (menu row and photo view),
  `public/kds/kds.js` (Carta panel).
- **Docs:** `docs/carta-ejemplo.csv` gains the column; README, `docs/estado-actual.md`, `CLAUDE.md`
  scope line.
- **No new dependencies.** No change to payments, rounds or any invariant.
