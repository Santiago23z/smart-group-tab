-- Smart Group Tab — development seed.
--
-- Static data only: a venue, its tables, and a menu. No sessions, rounds or cart
-- items, because a cart_item cannot exist without its shares (I1a) and building
-- those is the job of the phase 2 RPCs, not of a seed file.
--
-- Amounts are Colombian pesos, which have no subunit in practice — so the minor
-- unit here is the peso itself. Tax is impuesto al consumo at 8%, the rate that
-- applies to a gastrobar.

begin;

insert into venues (id, name, currency, default_service_mode, default_tip_mode, reservation_ttl)
values (
  '00000000-0000-4000-8000-000000000001',
  'Gastrobar La Prueba',
  'COP',
  'hybrid',
  'individual',
  interval '5 minutes'
);

insert into tables (venue_id, label, qr_token) values
  ('00000000-0000-4000-8000-000000000001', 'Mesa 1',  'qr-test-mesa-01'),
  ('00000000-0000-4000-8000-000000000001', 'Mesa 12', 'qr-test-mesa-12'),
  ('00000000-0000-4000-8000-000000000001', 'Barra 3', 'qr-test-barra-03');

insert into products (venue_id, name, category, unit_price, tax_rate) values
  -- Chosen so an even three-way split leaves a remainder: 32000 / 3 = 10666.67.
  -- The allocator has to absorb it without drift, and the tests lean on that.
  ('00000000-0000-4000-8000-000000000001', 'Picada para compartir', 'Para compartir', 32000, 0.08),
  ('00000000-0000-4000-8000-000000000001', 'Tabla de quesos',       'Para compartir', 45000, 0.08),
  ('00000000-0000-4000-8000-000000000001', 'Hamburguesa de la casa','Fuertes',        28000, 0.08),
  ('00000000-0000-4000-8000-000000000001', 'Ceviche de camarón',    'Fuertes',        34000, 0.08),
  ('00000000-0000-4000-8000-000000000001', 'Cerveza artesanal',     'Bebidas',        12000, 0.08),
  ('00000000-0000-4000-8000-000000000001', 'Michelada',             'Bebidas',        15000, 0.08),
  ('00000000-0000-4000-8000-000000000001', 'Botella de ron',        'Bebidas',       120000, 0.08),
  ('00000000-0000-4000-8000-000000000001', 'Limonada de coco',      'Bebidas',        14000, 0.08);

commit;
