# Design

## Context

- The mode lives in `venues.default_service_mode`. `open_or_join_session` copies it onto the
  session when a table opens, and every later decision reads the session's copy
  (session-lifecycle: "Operating mode is snapshotted at session open"). So changing the venue's
  value is already safe for open tables: nothing else has to move.
- Staff actions are `SECURITY DEFINER` functions answering `{status, reason?}`, reached through
  `ACTIONS` in `src/kds/app.mjs` (a refusal is 409, an `unknown_*` reason 404) and logged with
  `staff_log(kind, target, session, details)`.
- The kitchen already has a per-venue panel: *Carta*, with a venue selector when there is more
  than one venue. `/kds/api/venues` returns `id, name`.
- `loadVenue` (`npm run venue:load`) always writes the mode, and `scripts/venue.mjs` defaults
  `--mode` to `pay_before_order`.

## Goals / Non-Goals

**Goals:**
- One staff action that changes one column, logged, refused cleanly.
- The kitchen's choice survives the command-line loader.

**Non-Goals:**
- Completing `hybrid` (a way to leave a prepaid balance): a separate change.
- Changing the mode of a table already open, or tip mode / reservation time per venue.

## Decisions

**D1. `staff_set_service_mode(venue_id, mode text)`.**
- Rejects `invalid_mode` unless the mode is `pay_before_order` or `open_tab`, so `hybrid` cannot be
  chosen from the kitchen even by a hand-made request.
- Rejects `unknown_venue` when the venue does not exist.
- Locks the venue row (`for update`). If the mode is unchanged it answers `unchanged` and logs
  nothing; otherwise it updates, logs `set_service_mode` with `{from, to}`, and answers `updated`.
*Alternative:* allow `hybrid` with a warning. Rejected: the user chose to finish hybrid first.

**D2. Route and venue list.**
`POST /kds/api/venues/:id/service-mode {mode}` joins `ACTIONS`. `/kds/api/venues` adds `mode`, so
the panel shows the current value, `hybrid` included.

**D3. Where it sits on screen.**
At the top of the *Carta* panel, under the venue selector: "Cómo se cobra", two buttons as a
segmented control (*Pagar antes* / *Cuenta abierta*), one line under each, and "Aplica a las mesas
que se abran desde ahora." For a `hybrid` venue, a third, disabled segment reads *Híbrido (actual)*.
Switching asks for confirmation, because it changes what the next diners are allowed to do.
*Alternative:* a new *Ajustes* button. Rejected for now: one setting does not justify another
top-level button, and the Carta panel is already where a venue is chosen.

**D4. `venue:load` keeps the mode unless told otherwise.**
`scripts/venue.mjs` passes `mode` only when `--mode` is given. `loadVenue` writes the mode on an
existing venue only when one is given, and creates a new venue with `pay_before_order` when none is.
A given mode is still validated, `hybrid` included: the command line is the operator's tool and may
still set it.

## Risks / Trade-offs

- [Staff switch to *Cuenta abierta* by mistake on a busy night] → Confirmation first; the log
  records who-knows-when; switching back is one tap, and open tables were never affected.
- [Two venues on one screen] → The action names the venue chosen in the panel's selector, as the
  menu upload already does.

## Migration Plan

One additive migration (the function, execute revoked from `public, anon, authenticated` like the
other staff actions). Rollback: drop the function and revert the files; `venues` is untouched.
