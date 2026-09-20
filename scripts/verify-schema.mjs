#!/usr/bin/env node
// Smart Group Tab — phase 1 structural verification.
//
// Runs the migrations and the seed against PGlite (Postgres compiled to WASM) and
// asserts the things that do NOT need concurrency: the constraint triggers fire,
// the snapshots hold, the append-only ledger refuses mutation, RLS denies writes.
//
// What this canNOT verify is I1b and I2 — mutual exclusion and exactly-once
// dispatch only mean anything under real parallel connections, and PGlite is
// single-connection. Those are phase 2 against a real server.
//
//   node scripts/verify-schema.mjs

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = await PGlite.create()

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
    passed++
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`      ${err.message.split('\n')[0]}`)
    failures.push(name)
  }
}

/** Asserts the statement fails, and that it fails for the expected reason. */
async function rejects(sql, ...expected) {
  let threw = null
  try {
    await db.exec(sql)
  } catch (err) {
    threw = err
  }
  if (!threw) throw new Error(`expected a rejection, statement succeeded`)
  if (expected.length > 0 && !expected.some((e) => threw.message.includes(e))) {
    throw new Error(`rejected for the wrong reason: ${threw.message.split('\n')[0]}`)
  }
}

async function one(sql) {
  const { rows } = await db.query(sql)
  return rows[0]
}

/** bigint and numeric come back as strings; compare as numbers or nothing matches. */
const n = (v) => Number(v)

/** Runs fn with the connection acting as a guest or as venue staff. */
async function asRole(role, settings, fn) {
  try {
    await db.exec(`set role ${role}`)
    for (const [k, v] of Object.entries(settings)) {
      await db.exec(`set ${k} = '${v}'`)
    }
    return await fn()
  } finally {
    await db.exec('reset role').catch(() => {})
    for (const k of Object.keys(settings)) {
      await db.exec(`reset ${k}`).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\nMigrations')
// ---------------------------------------------------------------------------
const migrationsDir = join(root, 'supabase', 'migrations')
const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()

for (const file of files) {
  await check(file, async () => {
    await db.exec(await readFile(join(migrationsDir, file), 'utf8'))
  })
}

await check('seed.sql', async () => {
  await db.exec(await readFile(join(root, 'supabase', 'seed.sql'), 'utf8'))
})

if (failures.length > 0) {
  console.log('\nMigrations failed; skipping assertions.\n')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// A minimal live table, built the way the phase 2 RPCs will build it.
// ---------------------------------------------------------------------------
const venueId = '00000000-0000-4000-8000-000000000001'

await db.exec(`
  insert into sessions (id, table_id, venue_id, service_mode, tip_mode, reservation_ttl)
  select '00000000-0000-4000-8000-000000000010', id, venue_id,
         'hybrid', 'individual', interval '5 minutes'
    from tables where qr_token = 'qr-test-mesa-12';

  insert into participants (id, session_id, nickname) values
    ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000010', 'Santi'),
    ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000010', 'Cachetona'),
    ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000010', 'Mesero');

  insert into rounds (id, session_id, round_number, requires_prepayment)
  values ('00000000-0000-4000-8000-000000000030',
          '00000000-0000-4000-8000-000000000010', 1,
          requires_prepayment('00000000-0000-4000-8000-000000000010', 1));
`)

const roundId = '00000000-0000-4000-8000-000000000030'
const picada = await one(`select id, unit_price, tax_rate from products where name = 'Picada para compartir'`)

// ---------------------------------------------------------------------------
console.log('\nI1a — conservation')
// ---------------------------------------------------------------------------

await check('a cart_item with no shares is rejected at commit', async () => {
  await rejects(
    `begin;
     insert into cart_items (round_id, product_id, quantity, unit_price, tax_rate, added_by_participant_id)
     values ('${roundId}', '${picada.id}', 1, ${picada.unit_price}, ${picada.tax_rate},
             '00000000-0000-4000-8000-000000000021');
     commit;`,
    'I1a violated'
  )
  await db.exec('rollback').catch(() => {})
})

await check('shares that do not sum to line_total are rejected', async () => {
  await rejects(
    `begin;
     insert into cart_items (id, round_id, product_id, quantity, unit_price, tax_rate, added_by_participant_id)
     values ('00000000-0000-4000-8000-000000000041', '${roundId}', '${picada.id}', 1,
             ${picada.unit_price}, ${picada.tax_rate}, '00000000-0000-4000-8000-000000000021');
     insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
     values ('00000000-0000-4000-8000-000000000041', '${roundId}',
             '00000000-0000-4000-8000-000000000021', 1);
     commit;`,
    'I1a violated'
  )
  await db.exec('rollback').catch(() => {})
})

// 32000 + 8% tax = 34560. Three ways: 11520 each, no remainder.
// Deliberately pick a quantity that does leave one: 34560 is divisible by 3, so
// use the cheese board (45000 + 8% = 48600, /7 leaves a remainder).
await check('allocate_evenly sums to exactly the total, remainder and all', async () => {
  const r = await one(`
    select allocate_evenly(48600, 7) as parts,
           (select sum(x) from unnest(allocate_evenly(48600, 7)) as x) as total,
           (select max(x) - min(x) from unnest(allocate_evenly(48600, 7)) as x) as spread
  `)
  if (Number(r.total) !== 48600) throw new Error(`parts sum to ${r.total}, expected 48600`)
  if (Number(r.spread) > 1) throw new Error(`parts differ by ${r.spread}, expected at most 1`)
})

await check('an item split three ways commits cleanly', async () => {
  await db.exec(`
    begin;
    insert into cart_items (id, round_id, product_id, quantity, unit_price, tax_rate, added_by_participant_id)
    values ('00000000-0000-4000-8000-000000000050', '${roundId}', '${picada.id}', 1,
            ${picada.unit_price}, ${picada.tax_rate}, '00000000-0000-4000-8000-000000000021');

    insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
    select '00000000-0000-4000-8000-000000000050', '${roundId}',
           '00000000-0000-4000-8000-000000000021', part
      from unnest(allocate_evenly(
             (select line_total from cart_items where id = '00000000-0000-4000-8000-000000000050'), 3)) as part;
    commit;
  `)
  const r = await one(`
    select (select line_total from cart_items where id = '00000000-0000-4000-8000-000000000050') as total,
           (select sum(owed_amount) from cart_item_shares
             where cart_item_id = '00000000-0000-4000-8000-000000000050') as shares,
           (select count(*) from cart_item_shares
             where cart_item_id = '00000000-0000-4000-8000-000000000050') as n
  `)
  if (n(r.total) !== n(r.shares)) throw new Error(`line_total ${r.total} vs shares ${r.shares}`)
  if (n(r.n) !== 3) throw new Error(`expected 3 shares, got ${r.n}`)
})

await check('splitting an unclaimed share preserves the sum', async () => {
  const before = await one(`
    select sum(owed_amount) as total from cart_item_shares
     where cart_item_id = '00000000-0000-4000-8000-000000000050'`)

  // Exactly what a free-amount claim does: shrink one share, insert the remainder.
  await db.exec(`
    begin;
    with victim as (
      select id, owed_amount from cart_item_shares
       where cart_item_id = '00000000-0000-4000-8000-000000000050'
       order by id limit 1
    )
    insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
    select '00000000-0000-4000-8000-000000000050', '${roundId}', null, 500 from victim;

    update cart_item_shares set owed_amount = owed_amount - 500
     where id = (select id from cart_item_shares
                  where cart_item_id = '00000000-0000-4000-8000-000000000050'
                    and participant_id is not null
                  order by id limit 1);
    commit;
  `)

  const after = await one(`
    select sum(owed_amount) as total, count(*) as n from cart_item_shares
     where cart_item_id = '00000000-0000-4000-8000-000000000050'`)
  if (n(before.total) !== n(after.total)) {
    throw new Error(`sum moved: ${before.total} -> ${after.total}`)
  }
  if (n(after.n) !== 4) throw new Error(`expected 4 shares after the split, got ${after.n}`)
})

// ---------------------------------------------------------------------------
console.log('\nSnapshots')
// ---------------------------------------------------------------------------

await check('changing the menu price does not move round_total', async () => {
  const before = await one(`select round_total('${roundId}') as t`)
  await db.exec(`update products set unit_price = unit_price * 2 where id = '${picada.id}'`)
  const after = await one(`select round_total('${roundId}') as t`)
  if (n(before.t) !== n(after.t)) throw new Error(`round_total moved: ${before.t} -> ${after.t}`)
  await db.exec(`update products set unit_price = unit_price / 2 where id = '${picada.id}'`)
})

await check('changing the venue modality does not move an open session', async () => {
  await db.exec(`update venues set default_service_mode = 'open_tab' where id = '${venueId}'`)
  const r = await one(`
    select service_mode::text as mode,
           requires_prepayment('00000000-0000-4000-8000-000000000010', 1) as prepay
      from sessions where id = '00000000-0000-4000-8000-000000000010'`)
  if (r.mode !== 'hybrid') throw new Error(`session drifted to ${r.mode}`)
  if (r.prepay !== true) throw new Error('hybrid round 1 must still require prepayment')
})

await check('requires_prepayment resolves all three modalities', async () => {
  const cases = [
    ['pay_before_order', 1, true],
    ['pay_before_order', 5, true],
    ['open_tab', 1, false],
    ['hybrid', 1, true],
    ['hybrid', 2, false],
  ]
  for (const [mode, n, expected] of cases) {
    await db.exec(`update sessions set service_mode = '${mode}'
                    where id = '00000000-0000-4000-8000-000000000010'`)
    const r = await one(`select requires_prepayment('00000000-0000-4000-8000-000000000010', ${n}) as p`)
    if (r.p !== expected) throw new Error(`${mode} round ${n}: expected ${expected}, got ${r.p}`)
  }
  await db.exec(`update sessions set service_mode = 'hybrid'
                  where id = '00000000-0000-4000-8000-000000000010'`)
})

// ---------------------------------------------------------------------------
console.log('\nLedger integrity')
// ---------------------------------------------------------------------------

await check('one live session per table', async () => {
  await rejects(
    `insert into sessions (table_id, venue_id, service_mode, tip_mode, reservation_ttl)
     select id, venue_id, 'hybrid', 'individual', interval '5 minutes'
       from tables where qr_token = 'qr-test-mesa-12'`,
    'sessions_one_live_per_table'
  )
})

await check('one draft round per session', async () => {
  await rejects(
    `insert into rounds (session_id, round_number, requires_prepayment)
     values ('00000000-0000-4000-8000-000000000010', 2, true)`,
    'rounds_one_draft_per_session'
  )
})

await check('a reservation whose allocations do not match is rejected', async () => {
  await rejects(
    `begin;
     insert into contribution_reservations
       (id, round_id, participant_id, order_amount, idempotency_key, psp_reference, expires_at)
     values ('00000000-0000-4000-8000-000000000060', '${roundId}',
             '00000000-0000-4000-8000-000000000021', 9999, 'idem-1', 'psp-1', now() + interval '5 min');
     commit;`,
    'allocates 0'
  )
  await db.exec('rollback').catch(() => {})
})

await check('contributions are append-only', async () => {
  await db.exec(`
    insert into webhook_events (id, event_id, payload)
    values ('00000000-0000-4000-8000-000000000070', 'evt-1', '{}'::jsonb);

    begin;
    insert into contribution_reservations
      (id, round_id, participant_id, order_amount, idempotency_key, psp_reference, expires_at)
    values ('00000000-0000-4000-8000-000000000061', '${roundId}',
            '00000000-0000-4000-8000-000000000021', 1000, 'idem-2', 'psp-2', now() + interval '5 min');
    insert into reservation_allocations (reservation_id, cart_item_share_id, amount)
    select '00000000-0000-4000-8000-000000000061', id, 1000
      from cart_item_shares where owed_amount >= 1000
       and cart_item_id = '00000000-0000-4000-8000-000000000050' order by id limit 1;
    commit;

    insert into contributions
      (id, reservation_id, round_id, session_id, participant_id, order_amount, webhook_event_id)
    values ('00000000-0000-4000-8000-000000000080', '00000000-0000-4000-8000-000000000061',
            '${roundId}', '00000000-0000-4000-8000-000000000010',
            '00000000-0000-4000-8000-000000000021', 1000,
            '00000000-0000-4000-8000-000000000070');
  `)

  await rejects(
    `update contributions set order_amount = 1 where id = '00000000-0000-4000-8000-000000000080'`,
    'append-only'
  )
  await rejects(
    `delete from contributions where id = '00000000-0000-4000-8000-000000000080'`,
    'append-only'
  )
})

await check('a duplicate PSP event id is refused', async () => {
  await rejects(
    `insert into webhook_events (event_id, payload) values ('evt-1', '{}'::jsonb)`,
    'webhook_events_provider_event_id_key'
  )
})

await check('a round dispatches to each channel at most once', async () => {
  await db.exec(`insert into dispatches (round_id, channel) values ('${roundId}', 'kds')`)
  await rejects(
    `insert into dispatches (round_id, channel) values ('${roundId}', 'kds')`,
    'dispatches_round_id_channel_key'
  )
  await db.exec(`insert into dispatches (round_id, channel) values ('${roundId}', 'print')`)
})

await check('refunds cannot exceed what was paid', async () => {
  await rejects(
    `insert into refunds (contribution_id, amount, reason, kind)
     values ('00000000-0000-4000-8000-000000000080', 5000, 'over the ceiling', 'refunded')`,
    'exceeding'
  )
  await db.exec(`
    insert into refunds (contribution_id, amount, reason, kind)
    values ('00000000-0000-4000-8000-000000000080', 1000, 'mesero cobró en caja', 'reversed')`)
})

await check('tip does not count toward settlement', async () => {
  const r = await one(`
    select round_is_fully_settled('${roundId}') as settled,
           round_outstanding('${roundId}') as outstanding`)
  if (r.settled !== false) throw new Error('round must not be settled with shares outstanding')
  if (Number(r.outstanding) <= 0) throw new Error('outstanding should be positive')
})

await check('a held share is not free; an expired hold releases it', async () => {
  const shareId = (await one(`
    select cart_item_share_id as id from reservation_allocations
     where reservation_id = '00000000-0000-4000-8000-000000000061'`)).id

  const held = await one(`select is_share_held('${shareId}') as h`)
  if (held.h !== true) throw new Error('share should be held by the active reservation')

  await db.exec(`update contribution_reservations set expires_at = now() - interval '1 minute'
                  where id = '00000000-0000-4000-8000-000000000061'`)
  const stillHeld = await one(`select is_share_held('${shareId}') as h`)
  if (stillHeld.h !== false) throw new Error('an expired hold must release the share lazily')

  // ...unless the payment settled, in which case it is held forever.
  await db.exec(`update contribution_reservations set status = 'confirmed'
                  where id = '00000000-0000-4000-8000-000000000061'`)
  const settled = await one(`select is_share_held('${shareId}') as h`)
  if (settled.h !== true) throw new Error('a confirmed reservation must hold its share past expiry')
})

// ---------------------------------------------------------------------------
console.log('\nRLS')
// ---------------------------------------------------------------------------

const guest = { 'app.participant_id': '00000000-0000-4000-8000-000000000021' }

await check('a guest cannot write to any table, money or not', async () => {
  // Each statement is one that succeeds as superuser, so a rejection can only be
  // the missing write policy — not a NOT NULL violation arriving first.
  const writes = {
    cart_items: `insert into cart_items
      (round_id, product_id, quantity, unit_price, tax_rate, added_by_participant_id)
      values ('${roundId}', '${picada.id}', 1, 1000, 0, '00000000-0000-4000-8000-000000000021')`,
    cart_item_shares: `insert into cart_item_shares (cart_item_id, round_id, owed_amount)
      values ('00000000-0000-4000-8000-000000000050', '${roundId}', 1)`,
    contribution_reservations: `insert into contribution_reservations
      (round_id, participant_id, order_amount, idempotency_key, psp_reference, expires_at)
      values ('${roundId}', '00000000-0000-4000-8000-000000000021', 1, 'x', 'y', now())`,
    participants: `insert into participants (session_id, nickname)
      values ('00000000-0000-4000-8000-000000000010', 'intruso')`,
  }

  for (const [table, sql] of Object.entries(writes)) {
    // Either layer refusing is a pass: no INSERT was granted, and no write policy
    // exists. Both must hold, so accept whichever fires first.
    await asRole('anon', guest, () =>
      rejects(sql, 'permission denied', 'row-level security'))
  }
})

await check('a guest sees only their own session', async () => {
  const seen = await asRole('anon', guest, () => one(`select count(*) as n from sessions`))
  if (n(seen.n) !== 1) throw new Error(`guest saw ${seen.n} sessions, expected 1`)
})

await check('a guest sees their tablemates and nobody else', async () => {
  const seen = await asRole('anon', guest, () => one(`select count(*) as n from participants`))
  if (n(seen.n) !== 3) throw new Error(`guest saw ${seen.n} participants, expected 3`)
})

await check('a guest with no identity sees nothing', async () => {
  const seen = await asRole('anon', {}, () =>
    one(`select (select count(*) from sessions) as s, (select count(*) from cart_items) as c`))
  if (n(seen.s) !== 0 || n(seen.c) !== 0) {
    throw new Error(`unidentified guest saw ${seen.s} sessions and ${seen.c} items`)
  }
})

await check('a guest cannot read raw webhook payloads', async () => {
  await asRole('anon', guest, () => rejects(`select * from webhook_events`, 'permission denied'))
})

await check('staff scoped to a venue sees its dispatches; a guest does not', async () => {
  const asGuest = await asRole('anon', guest, () => one(`select count(*) as n from dispatches`))
  if (n(asGuest.n) !== 0) throw new Error(`guest saw ${asGuest.n} dispatches, expected 0`)

  const asStaff = await asRole('anon', { 'app.staff_venue_id': venueId }, () =>
    one(`select count(*) as n from dispatches`))
  if (n(asStaff.n) !== 2) throw new Error(`staff saw ${asStaff.n} dispatches, expected 2`)
})

// ---------------------------------------------------------------------------
console.log(
  failures.length === 0
    ? `\n\x1b[32m${passed} checks passed.\x1b[0m\n`
    : `\n\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed:\n  ${failures.join('\n  ')}\n`
)
process.exit(failures.length === 0 ? 0 : 1)
