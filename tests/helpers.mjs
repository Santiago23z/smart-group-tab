// Smart Group Tab — test fixtures.
//
// Every fixture builds its own venue, so tests never collide and can run in
// parallel. Rows are inserted as the superuser, which bypasses RLS — the point of
// these tests is concurrency, not authorization (that is covered by
// scripts/verify-schema.mjs).

import pg from 'pg'

export const connectionString =
  process.env.DATABASE_URL ?? 'postgres://santiagozapata@localhost:5432/smart_group_tab'

/**
 * A pool wide enough that N parallel queries really do get N distinct backends.
 * With a narrower pool the "race" would be serialized by the client library
 * before Postgres ever saw it, and the test would prove nothing.
 */
export function makePool(max = 32) {
  return new pg.Pool({ connectionString, max })
}

/**
 * Builds a live round ready for collection.
 *
 * items: [{ price, taxRate = 0, splitWays = 1, owner = 0 }]
 *   owner is an index into the created participants, or null for an unowned
 *   share that anyone may claim.
 */
export async function createFixture(pool, { participants = 3, items = [], status = 'locked_for_payment' } = {}) {
  const db = await pool.connect()
  try {
    await db.query('begin')

    const venue = (await db.query(
      `insert into venues (name, default_service_mode, reservation_ttl)
       values ('fixture', 'pay_before_order', interval '5 minutes') returning id`
    )).rows[0]

    const table = (await db.query(
      `insert into tables (venue_id, label, qr_token)
       values ($1, 'M1', gen_random_uuid()::text) returning id`,
      [venue.id]
    )).rows[0]

    const session = (await db.query(
      `insert into sessions (table_id, venue_id, service_mode, tip_mode, reservation_ttl)
       values ($1, $2, 'pay_before_order', 'individual', interval '5 minutes') returning id`,
      [table.id, venue.id]
    )).rows[0]

    const participantIds = []
    for (let i = 0; i < participants; i++) {
      const p = (await db.query(
        `insert into participants (session_id, nickname) values ($1, $2) returning id`,
        [session.id, `p${i}`]
      )).rows[0]
      participantIds.push(p.id)
    }

    const round = (await db.query(
      `insert into rounds (session_id, round_number, status, requires_prepayment)
       values ($1, 1, $2, true) returning id`,
      [session.id, status]
    )).rows[0]

    const itemIds = []
    const shareIds = []

    for (const [i, spec] of items.entries()) {
      const { price, taxRate = 0, splitWays = 1, owner = 0 } = spec

      const product = (await db.query(
        `insert into products (venue_id, name, unit_price, tax_rate)
         values ($1, $2, $3, $4) returning id`,
        [venue.id, `product-${i}`, price, taxRate]
      )).rows[0]

      const item = (await db.query(
        `insert into cart_items
           (round_id, product_id, quantity, unit_price, tax_rate, added_by_participant_id)
         values ($1, $2, 1, $3, $4, $5)
         returning id, line_total`,
        [round.id, product.id, price, taxRate, participantIds[0]]
      )).rows[0]
      itemIds.push(item.id)

      // Shares are built with the same allocator the production code uses, so a
      // fixture can never drift from what reserve_contribution would produce.
      const created = (await db.query(
        `insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
         select $1, $2, $3, part from unnest(allocate_evenly($4::bigint, $5::int)) as part
         returning id`,
        [
          item.id,
          round.id,
          owner === null ? null : participantIds[owner % participantIds.length],
          item.line_total,
          splitWays,
        ]
      )).rows
      shareIds.push(...created.map((r) => r.id))
    }

    await db.query('commit')

    const total = (await db.query(`select round_total($1) as t`, [round.id])).rows[0].t

    return {
      venueId: venue.id,
      sessionId: session.id,
      roundId: round.id,
      participantIds,
      itemIds,
      shareIds,
      roundTotal: Number(total),
    }
  } catch (err) {
    await db.query('rollback').catch(() => {})
    throw err
  } finally {
    db.release()
  }
}

/** Assigns share i to participant i, so "my_items" has something to resolve. */
export async function assignSharesRoundRobin(pool, { shareIds, participantIds }) {
  for (const [i, shareId] of shareIds.entries()) {
    await pool.query(`update cart_item_shares set participant_id = $1 where id = $2`, [
      participantIds[i % participantIds.length],
      shareId,
    ])
  }
}

/**
 * Namespaces every idempotency key to this process.
 *
 * idempotency_key is globally unique by design — that is the whole point — so a
 * literal key like 'race-0' would be found again on the next run and return a
 * stale 'duplicate' instead of racing. Tests stay readable using short logical
 * keys; this keeps runs from colliding with each other.
 */
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** One call to the RPC. Returns the jsonb result, whatever its status. */
export async function reserve(pool, { roundId, participantId, mode, amount = null, shareIds = null, tip = 0, key }) {
  const { rows } = await pool.query(
    `select reserve_contribution($1, $2, $3::split_mode, $4, $5::bigint, $6::uuid[], $7::bigint) as r`,
    [roundId, participantId, mode, `${RUN}/${key ?? Math.random()}`, amount, shareIds, tip]
  )
  return rows[0].r
}

/**
 * Fires N reservations simultaneously. Promise.all over a wide pool is what makes
 * these genuinely concurrent: each call lands on its own backend and they all
 * reach the round lock at once.
 */
export async function raceReservations(pool, calls) {
  return Promise.all(calls.map((c) => reserve(pool, c)))
}

// ---------------------------------------------------------------------------
// The ordering half: venue setup and the session / cart RPCs.
// ---------------------------------------------------------------------------

/** A venue with one table and a menu, but no session yet. */
export async function createVenue(pool, { serviceMode = 'pay_before_order', products = [] } = {}) {
  const venue = (await pool.query(
    `insert into venues (name, default_service_mode, reservation_ttl)
     values ('fixture', $1::service_mode, interval '5 minutes') returning id`,
    [serviceMode]
  )).rows[0]

  const qrToken = `qr-${Math.random().toString(36).slice(2)}`
  const table = (await pool.query(
    `insert into tables (venue_id, label, qr_token) values ($1, 'M1', $2) returning id`,
    [venue.id, qrToken]
  )).rows[0]

  const menu = []
  for (const [i, p] of products.entries()) {
    const row = (await pool.query(
      `insert into products (venue_id, name, unit_price, tax_rate)
       values ($1, $2, $3, $4) returning id, unit_price, tax_rate`,
      [venue.id, `item-${i}`, p.price, p.taxRate ?? 0]
    )).rows[0]
    menu.push(row)
  }

  return { venueId: venue.id, tableId: table.id, qrToken, menu }
}

export async function joinSession(pool, { qrToken, nickname }) {
  const { rows } = await pool.query(`select open_or_join_session($1, $2) as r`, [qrToken, nickname])
  return rows[0].r
}

export async function addItem(
  pool,
  { sessionId, participantId, productId, quantity = 1, sharedWith = null }
) {
  const { rows } = await pool.query(
    `select add_cart_item($1, $2, $3, $4::int, $5::uuid[]) as r`,
    [sessionId, participantId, productId, quantity, sharedWith]
  )
  return rows[0].r
}

export async function voidItem(pool, { cartItemId, participantId }) {
  const { rows } = await pool.query(`select void_cart_item($1, $2) as r`, [cartItemId, participantId])
  return rows[0].r
}

export async function setItemSharing(pool, { cartItemId, participantIds, participantId = null }) {
  const { rows } = await pool.query(`select set_item_sharing($1, $2::uuid[], $3::uuid) as r`, [
    cartItemId,
    participantIds,
    // Defaults to the first target, which is what the pre-review callers meant
    // implicitly: you reshare an item you are part of.
    participantId ?? participantIds[0],
  ])
  return rows[0].r
}

export async function closeRound(pool, { sessionId, splitMode = 'as_ordered' }) {
  const { rows } = await pool.query(`select close_round($1, $2) as r`, [sessionId, splitMode])
  return rows[0].r
}

/** What each participant ends up owing across a round, for equal-split checks. */
export async function owedPerParticipant(pool, roundId) {
  const { rows } = await pool.query(
    `select s.participant_id, sum(s.owed_amount)::bigint as owed
       from active_shares($1) s
      group by s.participant_id
      order by 2 desc`,
    [roundId]
  )
  return rows.map((r) => ({ participantId: r.participant_id, owed: Number(r.owed) }))
}

/**
 * Counts webhook rows this run wrote, matching a logical event-id pattern.
 *
 * Lives here rather than in the tests because getting it wrong is silent: an
 * unscoped `like '%/orphan'` accumulates across runs and the assertion only holds
 * the first time the database is fresh. That bug has now appeared twice.
 */
export async function webhookEventsFor(pool, pattern) {
  const { rows } = await pool.query(
    `select * from webhook_events where event_id like $1 order by received_at`,
    [`${RUN}/${pattern}`]
  )
  return rows
}

export async function countWebhookEvents(pool, pattern) {
  return (await webhookEventsFor(pool, pattern)).length
}

/** One webhook delivery. Returns the jsonb result, whatever its status. */
export async function confirmWebhook(
  pool,
  { provider = 'wompi', eventId, reference, outcome = 'approved', amount, payload = {}, verified = true }
) {
  const { rows } = await pool.query(
    `select confirm_webhook($1, $2, $3, $4, $5::bigint, $6::jsonb, $7) as r`,
    [provider, `${RUN}/${eventId}`, reference, outcome, amount, JSON.stringify(payload), verified]
  )
  return rows[0].r
}

/** Everything an I2/I3 assertion needs about a round and its session. */
export async function roundState(pool, roundId) {
  const { rows } = await pool.query(
    `select
       r.status::text                                                        as status,
       r.dispatched_at is not null                                           as dispatched,
       (select count(*) from dispatches d where d.round_id = r.id)           as dispatch_rows,
       (select count(distinct d.channel) from dispatches d
         where d.round_id = r.id)                                            as dispatch_channels,
       (select count(*) from contributions c where c.round_id = r.id)        as contributions,
       (select coalesce(sum(c.order_amount), 0) from contributions c
         where c.round_id = r.id and not c.applied_to_prepaid_balance)       as settled_amount,
       (select coalesce(sum(c.order_amount), 0) from contributions c
         where c.round_id = r.id and c.applied_to_prepaid_balance)           as credited_amount,
       s.prepaid_balance                                                     as prepaid_balance,
       s.status::text                                                        as session_status,
       round_total(r.id)                                                     as round_total,
       round_is_fully_settled(r.id)                                          as fully_settled
     from rounds r join sessions s on s.id = r.session_id
    where r.id = $1`,
    [roundId]
  )
  const r = rows[0]
  return {
    status: r.status,
    dispatched: r.dispatched,
    dispatchRows: Number(r.dispatch_rows),
    dispatchChannels: Number(r.dispatch_channels),
    contributions: Number(r.contributions),
    settledAmount: Number(r.settled_amount),
    creditedAmount: Number(r.credited_amount),
    prepaidBalance: Number(r.prepaid_balance),
    sessionStatus: r.session_status,
    roundTotal: Number(r.round_total),
    fullySettled: r.fully_settled,
  }
}

/** Reads back everything a concurrency assertion needs. */
export async function ledgerState(pool, roundId) {
  const { rows } = await pool.query(
    `select
       (select count(*) from contribution_reservations
         where round_id = $1 and status = 'active' and expires_at > now())    as live_reservations,
       (select coalesce(sum(order_amount), 0) from contribution_reservations
         where round_id = $1 and status in ('active','confirmed')
           and (status = 'confirmed' or expires_at > now()))                  as claimed_amount,
       round_total($1)                                                        as round_total,
       round_outstanding($1)                                                  as outstanding,
       (select count(*) from active_shares($1))                               as share_count,
       (select coalesce(sum(owed_amount), 0) from active_shares($1))          as share_sum,
       (select count(*) from (
          select ra.cart_item_share_id
            from reservation_allocations ra
            join contribution_reservations r on r.id = ra.reservation_id
           where r.round_id = $1
             and (r.status = 'confirmed' or (r.status = 'active' and r.expires_at > now()))
           group by ra.cart_item_share_id
          having count(*) > 1) dupes)                                         as double_claimed_shares`,
    [roundId]
  )
  const r = rows[0]
  return {
    liveReservations: Number(r.live_reservations),
    claimedAmount: Number(r.claimed_amount),
    roundTotal: Number(r.round_total),
    outstanding: Number(r.outstanding),
    shareCount: Number(r.share_count),
    shareSum: Number(r.share_sum),
    doubleClaimedShares: Number(r.double_claimed_shares),
  }
}
