#!/usr/bin/env node
// Smart Group Tab — invariant audit against whatever is actually in the database.
//
// The test suite proves the invariants hold for the scenarios someone thought to
// write. This proves they hold for every row that exists — including rows left
// behind by concurrent test runs, by hand, or by production.
//
// It is how the worst bug found so far surfaced: overcollection through a split
// share, which no test covered because it needed three separate conditions to
// coincide. The suite was green; the data was not.
//
//   DATABASE_URL=... node scripts/audit-invariants.mjs [--since <iso-timestamp>]

import pg from 'pg'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

const sinceFlag = process.argv.indexOf('--since')
const since = sinceFlag !== -1 ? process.argv[sinceFlag + 1] : null

const CHECKS = [
  {
    name: 'I1a  shares of an active item sum to its line_total',
    stamp: 'ci.created_at',
    sql: `select ci.id
            from cart_items ci
            left join cart_item_shares s on s.cart_item_id = ci.id
           where ci.status = 'active' AND_SINCE
           group by ci.id, ci.line_total
          having coalesce(sum(s.owed_amount), 0) <> ci.line_total`,
  },
  {
    name: 'I1a  a voided item owns no shares',
    stamp: 'ci.created_at',
    sql: `select ci.id from cart_items ci
           where ci.status = 'voided' AND_SINCE
             and exists (select 1 from cart_item_shares s where s.cart_item_id = ci.id)`,
  },
  {
    name: 'I1b  no share is held by two live reservations',
    stamp: 's.created_at',
    sql: `select ra.cart_item_share_id
            from reservation_allocations ra
            join contribution_reservations r on r.id = ra.reservation_id
            join cart_item_shares s on s.id = ra.cart_item_share_id
           where (r.status = 'confirmed'
                  or (r.status = 'active' and r.expires_at > now())) AND_SINCE
           group by ra.cart_item_share_id
          having count(*) > 1`,
  },
  {
    name: 'I1c  no round collected more than it is worth',
    stamp: 'r.created_at',
    sql: `select r.id from rounds r
           where TRUE AND_SINCE
             and (select coalesce(sum(c.order_amount), 0) from contributions c
                   where c.round_id = r.id and not c.applied_to_prepaid_balance)
                 > round_total(r.id)`,
  },
  {
    name: 'I2   no round dispatched twice to one channel',
    stamp: 'd.created_at',
    sql: `select d.round_id from dispatches d
           where TRUE AND_SINCE
           group by d.round_id, d.channel having count(*) > 1`,
  },
  {
    name: 'I2   every dispatched round reached the outbox',
    stamp: 'r.created_at',
    sql: `select r.id from rounds r
           where r.status = 'paid_and_dispatched' AND_SINCE
             and (select count(*) from dispatches d where d.round_id = r.id) <> 2`,
  },
  {
    // A worker that is not running is otherwise invisible: rows pile up at
    // `pending`, every other invariant stays green, and food that was paid for
    // is not being cooked. That was this repo's actual state until the worker
    // existed — every dispatch ever recorded sat here undelivered while the
    // suite reported nothing wrong.
    //
    // The threshold is generous on purpose. Retry backoff caps at a minute and
    // the attempt ceiling is reached in a few, so anything still pending after
    // fifteen means nobody is draining the queue.
    //
    // Note what is deliberately NOT audited: a dispatch in `failed`. That is a
    // correctly recorded incident, not a violated invariant — it legitimately
    // can be true, and an invariant is something that must never be. Auditing it
    // would mean the audit could never be green again in a venue that has ever
    // had a kitchen display fail, which destroys its value as a binary signal.
    // Terminal failure reaches a human through the session flag instead.
    name: 'I2   no dispatch left undelivered long past its backoff',
    stamp: 'd.created_at',
    sql: `select d.id from dispatches d
           where d.status = 'pending' AND_SINCE
             and d.next_attempt_at < now() - interval '15 minutes'`,
  },
  {
    name: 'I3   every contribution names a real webhook event',
    stamp: 'c.created_at',
    sql: `select c.id from contributions c
           where TRUE AND_SINCE
             and not exists (select 1 from webhook_events w where w.id = c.webhook_event_id)`,
  },
  {
    // The one the review's worst finding violated. An allocation that no longer
    // matches the share it points at means a split went through without carrying
    // the claim, and a late approval can settle for more than the share is worth.
    name: 'ledger  every live allocation matches the share it claims',
    stamp: 's.created_at',
    sql: `select ra.id
            from reservation_allocations ra
            join contribution_reservations r on r.id = ra.reservation_id
            join cart_item_shares s on s.id = ra.cart_item_share_id
           where r.status in ('active', 'confirmed') AND_SINCE
             and ra.amount <> s.owed_amount`,
  },
  {
    name: 'ledger  a settled reservation has its contribution',
    stamp: 'r.created_at',
    sql: `select r.id from contribution_reservations r
           where r.status = 'confirmed'
             and r.settled_at is not null AND_SINCE
             and not exists (select 1 from contributions c where c.reservation_id = r.id)`,
  },
]

const client = new pg.Client({ connectionString })
await client.connect()

let failed = 0
console.log(since ? `\nAuditing rows created since ${since}\n` : '\nAuditing every row\n')

for (const check of CHECKS) {
  const sql = check.sql.replace(
    'AND_SINCE',
    since ? `and ${check.stamp} >= '${since}'::timestamptz` : ''
  )
  const { rows } = await client.query(sql)

  if (rows.length === 0) {
    console.log(`  \x1b[32m✓\x1b[0m ${check.name}`)
  } else {
    failed++
    console.log(`  \x1b[31m✗\x1b[0m ${check.name}  — ${rows.length} violation(s)`)
    console.log(`      e.g. ${rows.slice(0, 3).map((r) => Object.values(r)[0]).join(', ')}`)
  }
}

await client.end()

console.log(
  failed === 0
    ? `\n\x1b[32mAll ${CHECKS.length} invariants hold.\x1b[0m\n`
    : `\n\x1b[31m${failed} invariant(s) violated.\x1b[0m Use --since to separate history from now.\n`
)
process.exit(failed === 0 ? 0 : 1)
