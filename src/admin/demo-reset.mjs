// Smart Group Tab — wipe one night off a demo database, keep the bar.
//
// A demo needs free tables, an empty kitchen and zero takings, but the same
// venue, menu, photos and printed QR codes. The ledger tables are append-only
// row by row (contributions, manual_payments, write_offs…), so this TRUNCATEs
// them all in one statement instead: right for a demo database, never for a
// real bar's books. The CLI in scripts/demo-reset.mjs guards against that.

/** What a venue is: kept. */
export const KEPT_TABLES = ['venues', 'tables', 'products', 'product_photos', 'schema_migrations']

/** What a night is: emptied. */
export const NIGHT_TABLES = [
  'sessions', 'participants', 'rounds', 'cart_items', 'cart_item_shares',
  'contribution_reservations', 'reservation_allocations', 'reservation_checkouts',
  'contributions', 'webhook_events', 'refunds', 'manual_payments', 'cash_requests',
  'write_offs', 'write_off_shares', 'dispatches', 'kitchen_tickets',
  'staff_alert_acks', 'staff_action_log',
]

/** Row counts of the night tables, to show before and after. */
export async function nightCounts(db) {
  const parts = NIGHT_TABLES.map((t) => `(select count(*) from ${t})::int as ${t}`)
  return (await db.query(`select ${parts.join(', ')}`)).rows[0]
}

/** Empties the night and puts every sold-out dish back on the menu. One transaction. */
export async function resetNight(db) {
  await db.query('begin')
  try {
    await db.query(`truncate ${NIGHT_TABLES.join(', ')}`)
    const { rowCount } = await db.query('update products set sold_out = false where sold_out')
    await db.query('commit')
    return { backOnMenu: rowCount }
  } catch (err) {
    await db.query('rollback')
    throw err
  }
}

/** True when the database lives on this machine. */
export function isLocalDatabase(connectionString) {
  const host = new URL(connectionString).hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === ''
}
