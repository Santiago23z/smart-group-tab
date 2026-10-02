# Proposal

## Why

A menu without photos sells less, and the venue asked for it now. Scope was widened on
2026-10-02 (CLAUDE.md): one photo per dish, attached from the staff screen, shown on the diner
menu. Still no per-dish editor, descriptions or modifiers.

## What Changes

- In the staff screen's "Carta" panel each dish gets **Foto**: pick an image (from the tablet's
  camera roll or a file), see it, save it; **Cambiar** and **Quitar** afterwards.
- The image is **resized and compressed in the staff browser** before it is sent: a list
  thumbnail (~240 px) and a larger version (~800 px), JPEG. No new paid service and no new
  dependency: both are stored in Postgres, apart from the menu rows.
- The diner menu shows the **thumbnail** next to each dish that has one, loaded lazily; tapping
  it opens the larger photo. Dishes without a photo keep the current text row, so a menu with
  some, all or no photos looks deliberate.
- Photos are served from addresses that include a hash of their content, with a long cache: a
  phone downloads each photo once, and a replaced photo gets a new address, so it is never stale.
- The diner menu is redrawn only when it changes, not on every 2-second poll, so photos never
  flicker or download again.
- Uploading the menu spreadsheet never touches photos; a photo stays with its dish (by name)
  across uploads. Every photo change is in the staff action log.

Out of scope: photos in the spreadsheet (a link column), descriptions, more than one photo per
dish, server-side image processing.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `menu-self-service`: dishes can carry one photo, managed from the staff screen and shown to
  diners.

## Impact

- **DB**: `product_photos` table (thumbnail and large bytes, content type, hash), photo set/remove
  functions with venue check and log.
- **Code**: KDS upload/remove routes and Carta panel; diner API serves photos with immutable
  caching and includes each dish's photo hash in the menu; diner page shows thumbnails, the
  enlarged view, and stops redrawing an unchanged menu.
- **Specs**: 1 modified. No new dependencies.
