# Design

## Context

The menu spreadsheet is read by `parseMenu` (header aliases in `COLUMNS`, every mistake listed by
row) and written by `loadMenu`, which the CLI loader and the staff upload share; the upload's
preview runs the same writes inside a savepoint and rolls them back. `loadMenu` updates every
listed dish by name and counts it as updated, inserts new ones, and hides the rest. The diner
menu comes from `/api/state` and is redrawn only when `menuKey` changes; the large photo view is a
single full-screen button holding an `<img>`.

## Goals / Non-Goals

**Goals:**
- One more column through the existing path, with no second way to write a dish.
- Old spreadsheets (without the column) keep working and never wipe descriptions.

**Non-Goals:**
- Rich text, links or emoji handling beyond plain text.
- Per-language descriptions, allergens or any structured field.

## Decisions

**D1 — A nullable `products.description` column, checked in the database.** `text`, null meaning
"no description", with `check (char_length(description) <= 300)`. The parser enforces the same
limit first so the staff see the row; the check is the backstop. Alternative: a separate table
like `product_photos` — rejected, photos are there because of their size; a short text is a
plain attribute of the dish.

**D2 — "Column absent" and "cell empty" are different.** `parseMenu` returns `description:
undefined` for every item when the file has no description column, `null` for an empty cell and
the trimmed text otherwise; internal whitespace and line breaks inside a cell collapse to single
spaces. `loadMenu` writes the description only when the file had the column (a boolean parameter
in the same `update`/`insert`), so an old price-only file never clears what a newer one wrote.
Alternative: always overwrite — rejected, uploading last month's price list would silently erase
every description.

**D3 — Length counted in characters, the same way on both sides.** JavaScript counts code points
(`[...text].length`), which is what Postgres `char_length` counts, so an accented or emoji text
that passes the parser never trips the check.

**D4 — The diner sees it as text, never as markup.** The description goes through the existing
`escape()` like the name. In the menu row it is a text-styled button under the name, clamped to
two lines with `-webkit-line-clamp`; tapping toggles an `open` class that removes the clamp. Since
the menu is redrawn only when `menuKey` changes (add-dish-photos, D5), the toggle survives polls;
`menuKey` gains the description so an upload that changes it does redraw. The photo view gets a
caption with the name and full description, looked up from `state.menu` by the product id already
in `data-photo`.

**D5 — The staff Carta panel shows it read-only.** The KDS menu listing adds `description`; the
panel prints it small under the dish name. The upload preview is unchanged: every listed dish is
already counted as updated.

## Risks / Trade-offs

- [The state polled every 2 s grows with 300-character texts] → 50 dishes is about 15 KB more per
  poll on the local network; acceptable for the MVP, and the menu could move to its own cached
  endpoint later without changing the spec.
- [A bar pastes a very long text] → refused with its row before anything is written.
- [`-webkit-line-clamp` on an old browser] → the text shows whole instead of cut; nothing breaks.

## Migration Plan

One additive migration (`alter table products add column description text` plus the check). No
backfill: every dish starts without a description. Rollback is dropping the column; no other table
refers to it.
