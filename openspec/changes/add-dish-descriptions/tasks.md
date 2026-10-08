# Tasks

## 1. Data and spreadsheet

- [x] 1.1 Migration `supabase/migrations/20261007000100_dish_descriptions.sql`: nullable `products.description` with `char_length <= 300` check (D1); `parseMenu` reads `descripcion`/`descripción`/`description`, collapses whitespace, errors past 300 characters with its row, returns `undefined` when the column is absent (D2, D3); `loadMenu` writes it only when the column was present. Tests in `tests/venue-setup.test.mjs`: description read, 301 characters refused with "fila N", accented text at exactly 300 accepted, file without the column keeps descriptions, empty cell clears one, hidden dish keeps it.

## 2. Servers

- [x] 2.1 `description` in the diner `/api/state` menu and in the KDS Carta menu listing; tests in `tests/api-bill.test.mjs` (or the closest diner API test) and `tests/kds.test.mjs` that both carry it after an upload.

## 3. Screens

- [x] 3.1 Diner menu: escaped description under the name, two-line clamp, tap to open; included in `menuKey`; photo view caption with name and full description (D4). Playwright in `tests/e2e/diner.spec.mjs`: description visible, tapping a long one shows it whole, the photo view shows it, a dish without description is unchanged.
- [x] 3.2 Staff Carta panel shows each dish's description (D5); Playwright in `tests/e2e/kds.spec.mjs`: an uploaded description shows in the panel.

## 4. Docs and verification

- [x] 4.1 `docs/carta-ejemplo.csv` with the column, README, `docs/estado-actual.md`, and the `CLAUDE.md` scope line (descriptions from the spreadsheet only; still no per-dish editor or modifiers).
- [x] 4.2 `npm run test:all` green; migrate the demo database; load descriptions for the demo dishes and screenshot the diner menu.
