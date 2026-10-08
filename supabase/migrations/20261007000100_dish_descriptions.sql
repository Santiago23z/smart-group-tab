-- Smart Group Tab — what comes in a dish, from the menu spreadsheet.
--
-- Plain text, null meaning none. The spreadsheet parser refuses a longer one
-- with its row first; this check is the backstop for any other writer.

alter table products
  add column description text,
  add constraint products_description_length check (char_length(description) <= 300);
