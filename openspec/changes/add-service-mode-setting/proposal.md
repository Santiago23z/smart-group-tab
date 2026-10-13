# Proposal

## Why

How a venue collects — pay before the kitchen sees anything, or run a tab and pay at the end — is
a business choice the venue makes, and may change (a quiet Tuesday vs. a Saturday night). Today it
can only be set from a terminal with `npm run venue:load --mode …`, which a bar will never run.
That command also resets the mode to `pay_before_order` whenever `--mode` is left out, so a choice
made any other way would be silently undone.

## What Changes

- From the kitchen screen, staff choose how the venue collects: **Pagar antes**
  (`pay_before_order`) or **Cuenta abierta** (`open_tab`), with one line explaining each.
- The choice applies to tables opened **after** it. Tables already open keep the mode they started
  with, as the existing session-lifecycle rule already requires; the screen says so.
- `hybrid` is **not offered** from the kitchen yet: today nothing lets a table leave a prepaid
  balance on purpose, so it behaves like `pay_before_order`. A venue already in `hybrid` sees it as
  its current mode and can switch away from it. Completing hybrid is a separate change.
- The change of mode is a staff action: it needs the staff credential and is logged with the old
  and new mode.
- `npm run venue:load` without `--mode` keeps an existing venue's mode instead of resetting it.
  A new venue still starts in `pay_before_order`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `staff-actions`: staff can set the venue's collection mode from the kitchen screen; the action is
  logged; reloading the venue without a mode keeps the chosen one.

## Impact

- **Database:** one migration with `staff_set_service_mode(venue, mode)`. No schema change: the
  mode already lives in `venues.default_service_mode`, and sessions already copy it when they open.
- **Code:** `src/kds/app.mjs` (venue list with its mode, one action route), `public/kds/*` (the
  choice in the Carta panel), `src/admin/venue.mjs` + `scripts/venue.mjs` (`--mode` optional on an
  existing venue).
- **Tests:** SQL, KDS route, `venue:load`, e2e (switch mode, open a new table, see the new rule).
- **Docs:** README, `docs/estado-actual.md`.
- **No new dependencies.** No change to payments, rounds, dispatch or any invariant.
