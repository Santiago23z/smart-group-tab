# Tasks

## 1. Database

- [x] 1.1 Migration `staff_set_service_mode(venue_id, mode)` (D1), execute revoked from `public, anon, authenticated`. Verify: test DB migrates and `npm run verify:schema` passes.
- [x] 1.2 SQL tests: switching to `open_tab` makes the next session at a free table `open_tab` and its round dispatch unpaid; a session already open keeps `pay_before_order`; `hybrid` and junk are refused with `invalid_mode` and change nothing; unknown venue → `unknown_venue`; same mode → `unchanged` with no log row; a change logs `set_service_mode` with `{from, to}`. Verify: `npm test` green, and the `hybrid` test fails if the check is removed.

## 2. Kitchen server

- [x] 2.1 `src/kds/app.mjs`: `mode` in `/kds/api/venues`; `POST /kds/api/venues/:id/service-mode` in `ACTIONS` (D2). Verify: `tests/kds.test.mjs` covers 200 updated, 409 `invalid_mode`, 404 unknown venue, 401 without the staff token.

## 3. Kitchen screen

- [x] 3.1 `public/kds/*`: "Cómo se cobra" in the Carta panel (D3): current mode marked, `hybrid` shown disabled as current, confirmation before switching, the note that it applies to new tables. Verify: e2e below and a screenshot.
- [x] 3.2 e2e: on a fresh venue in `pay_before_order`, staff switch to *Cuenta abierta*; a diner at a free table of that venue closes a round and it reaches the kitchen unpaid. Verify: `npm run test:e2e` green.

## 4. Command line

- [x] 4.1 `src/admin/venue.mjs` + `scripts/venue.mjs` (D4): no `--mode` keeps an existing venue's mode; a new venue without `--mode` is `pay_before_order`; a given mode is still validated. Verify: `tests/venue-setup.test.mjs` cases for all three.

## 5. Docs and full run

- [x] 5.1 README and `docs/estado-actual.md` (kitchen section, the three modes in plain words, history row). Verify: read through.
- [x] 5.2 `npm run test:all` green; demo migrated, kitchen restarted, checked through the tunnel. Verify: output and a screenshot.
