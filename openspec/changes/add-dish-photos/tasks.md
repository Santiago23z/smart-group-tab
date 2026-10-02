# Tasks

## 1. Data

- [x] 1.1 Migration `supabase/migrations/20261002000100_dish_photos.sql`: `product_photos`, `staff_set_photo`, `staff_remove_photo` (venue check, log); tests in `tests/dish-photos.test.mjs`: set, replace (new hash), remove, other venue refused, menu upload keeps the photo, log entries.

## 2. Servers

- [x] 2.1 KDS `PUT`/`DELETE /kds/api/venues/:v/products/:p/photo` with magic-byte and size checks, and `photo` in the Carta menu; tests in `tests/kds.test.mjs`: JPEG accepted, a text file and an oversized image refused (photo unchanged), staff token only.
- [x] 2.2 Diner `GET /photos/<product>/<hash>/<size>.jpg` with immutable caching and 404 on a stale hash; `photo` in `/api/state` menu; test the headers, the 404 and that the state carries the hash.

## 3. Screens

- [x] 3.1 Carta panel: Foto / Cambiar / Quitar per dish, resize in the browser (D1), "Procesando…"; Playwright: attach a photo and see it in the panel.
- [x] 3.2 Diner menu: thumbnails (lazy, fixed size), tap to enlarge, redraw only on change (D5); Playwright: the photo appears for a diner, a dish without photo is a text row, and the thumbnail is not re-requested across polls.

## 4. Docs and verification

- [x] 4.1 README, `docs/estado-actual.md`, and the CSV answer: photos are attached from the screen, not the spreadsheet.
- [x] 4.2 `npm run test:all` green; migrate the demo database; screenshot the diner menu with photos.
