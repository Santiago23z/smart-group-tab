-- Smart Group Tab — make allocations auditable in time.
--
-- Every other table on the money path carries created_at; reservation_allocations
-- did not. That gap cost real time during the first review: an audit turned up
-- shares that looked doubly claimed, and there was no way to tell from the data
-- whether the second claim had been written while the first was still live (a
-- genuine I1b breach) or long after it lapsed (harmless residue of the split bug
-- this same review fixed).
--
-- The answer turned out to be the second, but only a clean rebuild could prove
-- it. A timestamp would have answered it in one query.

alter table reservation_allocations
  add column created_at timestamptz not null default now();

create index reservation_allocations_created_idx
  on reservation_allocations (created_at);

comment on column reservation_allocations.created_at is
  'When this claim was written. Distinct from the reservation''s own created_at: '
  'a split propagates claims onto new shares after the fact, so an allocation can '
  'be younger than the reservation that owns it.';
