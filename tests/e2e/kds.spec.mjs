// Smart Group Tab — the kitchen screen, in a real browser.
//
// The real worker's drain() delivers to the real KDS server that Playwright
// started, and the page is expected to show it without anyone reloading.

import { test, expect } from '@playwright/test'
import pg from 'pg'
import { freshTable, sql, closePool } from './helpers.mjs'
import { drain } from '../../src/worker/run.mjs'
import { testDatabaseUrl } from '../../scripts/test-database.mjs'

// Same literals as playwright.config.mjs.
const DISPATCH_TOKEN = 'e2e-dispatch-token'
const STAFF_TOKEN = 'e2e-staff-token'
const VENUE = '00000000-0000-4000-8000-000000000001'

const pool = new pg.Pool({
  connectionString: testDatabaseUrl(),
  max: 2,
})

test.afterAll(async () => { await pool.end(); await closePool() })

/** A table with a round of two dishes in collection, nobody holding anything yet. */
async function openRound(name) {
  const qr = await freshTable(name)
  const [{ id: tableId, label }] = await sql(`select id, label from tables where qr_token = $1`, [qr])
  const [{ id: sessionId }] = await sql(
    `insert into sessions (table_id, venue_id, service_mode, tip_mode, reservation_ttl)
     values ($1, $2, 'pay_before_order', 'individual', interval '5 minutes') returning id`,
    [tableId, VENUE])
  const [{ id: participantId }] = await sql(
    `insert into participants (session_id, nickname) values ($1, 'Santi') returning id`, [sessionId])
  const [{ id: roundId }] = await sql(
    `insert into rounds (session_id, round_number, status, requires_prepayment)
     values ($1, 1, 'locked_for_payment', true) returning id`, [sessionId])
  // An item and its share in one transaction: I1a is checked at commit.
  const db = await pool.connect()
  try {
    await db.query('begin')
    for (const [dish, qty] of [['Hamburguesa KDS', 2], ['Limonada KDS', 1]]) {
      const { rows: [{ id: productId }] } = await db.query(
        `insert into products (venue_id, name, unit_price, tax_rate) values ($1, $2, 10000, 0) returning id`,
        [VENUE, `${dish} ${Date.now()}`])
      const { rows: [item] } = await db.query(
        `insert into cart_items (round_id, product_id, quantity, unit_price, tax_rate, added_by_participant_id)
         values ($1, $2, $3, 10000, 0, $4) returning id, line_total`, [roundId, productId, qty, participantId])
      await db.query(
        `insert into cart_item_shares (cart_item_id, round_id, participant_id, owed_amount)
         values ($1, $2, $3, $4)`, [item.id, roundId, participantId, item.line_total])
    }
    await db.query('commit')
  } catch (err) {
    await db.query('rollback').catch(() => {})
    throw err
  } finally { db.release() }
  return { roundId, sessionId, participantId, label }
}

/** The same, paid and released, its outbox rows waiting. */
async function paidRound(name) {
  const r = await openRound(name)
  await sql(`update rounds set status = 'paid_and_dispatched', dispatched_at = now() where id = $1`, [r.roundId])
  await sql(`insert into dispatches (round_id, channel) values ($1, 'kds'), ($1, 'print')`, [r.roundId])
  return r
}

/** Deliver this round, and only this round, the way the worker would. */
async function deliver(baseURL, roundId) {
  await sql(
    `update dispatches set next_attempt_at = now() + interval '1 hour'
      where status = 'pending' and round_id <> $1`, [roundId])
  const db = await pool.connect()
  try {
    await drain(db, {
      urls: { kds: `${baseURL}/ingest/kds`, print: `${baseURL}/ingest/print` },
      token: DISPATCH_TOKEN,
    })
  } finally { db.release() }
}

const openScreen = (page) => page.goto(`/kds#token=${STAFF_TOKEN}`)

// ---------------------------------------------------------------------------
test('without the staff link the screen shows nothing', async ({ page }) => {
  await page.goto('/kds')
  await expect(page.locator('#locked')).toBeVisible()
  await expect(page.locator('#kds')).toBeHidden()
})

test('a paid round appears without a reload, and "Listo" clears it', async ({ page, baseURL }) => {
  await openScreen(page)
  await expect(page.locator('#kds')).toBeVisible()
  // The token left the address bar.
  expect(page.url()).not.toContain('token')

  const { roundId, label } = await paidRound('kds')
  const ticket = page.locator(`.ticket[data-round="${roundId}"]`)
  await expect(ticket).toHaveCount(0)

  await deliver(baseURL, roundId)

  await expect(ticket).toBeVisible({ timeout: 8000 })
  await expect(ticket.locator('.ticket-table')).toHaveText(label)
  await expect(ticket).toContainText('Ronda 1')
  await expect(ticket).toContainText('2×')
  await expect(ticket).toContainText('Hamburguesa KDS')
  await expect(ticket).toContainText('Santi')
  // No money on the kitchen's screen.
  await expect(ticket).not.toContainText('$')

  await ticket.locator('button', { hasText: 'Listo' }).click()
  await expect(ticket).toHaveCount(0, { timeout: 8000 })

  const [row] = await sql(`select done_at from kitchen_tickets where round_id = $1`, [roundId])
  expect(row.done_at).not.toBeNull()
})

test('a table whose order never reached the kitchen is shown with its reason', async ({ page }) => {
  const { roundId, sessionId, label } = await paidRound('kds-fail')
  await sql(`update dispatches set status = 'failed', attempts = 8, last_error = 'HTTP 503 cocina caída'
              where round_id = $1`, [roundId])
  await sql(`update sessions set status = 'requires_staff_attention' where id = $1`, [sessionId])

  await openScreen(page)
  const alert = page.locator(`.alert[data-session="${sessionId}"]`)
  await expect(alert).toBeVisible({ timeout: 8000 })
  await expect(alert).toContainText(label)
  await expect(alert).toContainText('no llegó')
  await expect(alert).toContainText('503')

  await alert.locator('button', { hasText: 'Visto' }).click()
  await expect(alert).toHaveClass(/acked/, { timeout: 8000 })
  await expect(alert).toContainText('sigue sin resolver')

  const [s] = await sql(`select status from sessions where id = $1`, [sessionId])
  expect(s.status).toBe('requires_staff_attention')
})

// ---------------------------------------------------------------------------
// Staff actions
// ---------------------------------------------------------------------------
const rpc = async (fn, ...args) =>
  (await sql(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args))[0].r

/** The round paid twice: the second payment is credit and the table is flagged. */
async function paidTwice(name) {
  const r = await openRound(name)
  const claim = await rpc('reserve_contribution', r.roundId, r.participantId, 'remaining', `e2e-${Math.random()}`)
  for (const n of [1, 2]) {
    await rpc('confirm_webhook', 'wompi', `e2e-${n}-${Math.random()}`, claim.psp_reference, 'approved', claim.order_amount)
  }
  return { ...r, amount: Number(claim.order_amount) }
}

test('a double payment is refunded from the screen, and the table leaves the alerts', async ({ page }) => {
  const { sessionId, amount } = await paidTwice('kds-refund')
  await openScreen(page)
  const alert = page.locator(`.alert[data-session="${sessionId}"]`)
  await expect(alert).toContainText('saldo a favor', { timeout: 8000 })

  await alert.locator('button', { hasText: 'Devolver' }).click()
  const dialog = page.locator('#refund-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('input[name="amount"]')).toHaveValue(String(amount))
  await dialog.locator('input[name="reason"]').fill('Pagó dos veces')
  await dialog.locator('input[name="reference"]').fill('NEQUI-77')
  await dialog.locator('button[type="submit"]').click()

  // Recorded, but money on its way back is not back: the alert stays.
  const refund = alert.locator('.refund')
  await expect(refund).toContainText('pendiente', { timeout: 8000 })
  const [bal] = await sql(`select prepaid_balance from sessions where id = $1`, [sessionId])
  expect(Number(bal.prepaid_balance)).toBe(0)

  await refund.getByRole('button', { name: 'Llegó', exact: true }).click()
  await expect(alert).toHaveCount(0, { timeout: 8000 })
  const [s] = await sql(`select status from sessions where id = $1`, [sessionId])
  expect(s.status).toBe('open')
})

test('cancelling a round asks first, and "No" sends nothing', async ({ page }) => {
  const { roundId, label } = await openRound('kds-cancel')
  await openScreen(page)
  const card = page.locator(`.collection[data-round="${roundId}"]`)
  await expect(card).toContainText(label, { timeout: 8000 })
  await expect(card).toContainText('Falta $30.000 de $30.000')

  await card.locator('button', { hasText: 'Cancelar ronda' }).click()
  await expect(page.locator('#confirm-dialog')).toBeVisible()
  await expect(page.locator('#confirm-title')).toContainText(label)
  await page.locator('#confirm-dialog button', { hasText: 'No' }).click()
  await expect(page.locator('#confirm-dialog')).toBeHidden()
  expect((await sql(`select status from rounds where id = $1`, [roundId]))[0].status).toBe('locked_for_payment')

  await card.locator('button', { hasText: 'Cancelar ronda' }).click()
  await page.locator('#confirm-yes').click()
  await expect(card).toHaveCount(0, { timeout: 8000 })
  expect((await sql(`select status from rounds where id = $1`, [roundId]))[0].status).toBe('cancelled')
})

test('a failed delivery is retried from its alert', async ({ page }) => {
  const { roundId, sessionId } = await paidRound('kds-retry')
  await sql(`update dispatches set status = 'failed', attempts = 8, last_error = 'HTTP 503'
              where round_id = $1 and channel = 'kds'`, [roundId])
  await sql(`update dispatches set status = 'delivered', delivered_at = now()
              where round_id = $1 and channel = 'print'`, [roundId])
  await sql(`update sessions set status = 'requires_staff_attention' where id = $1`, [sessionId])

  await openScreen(page)
  const alert = page.locator(`.alert[data-session="${sessionId}"]`)
  await alert.locator('button', { hasText: 'Reintentar envío' }).click({ timeout: 8000 })
  await expect(alert).toHaveCount(0, { timeout: 8000 })

  const [d] = await sql(`select status, attempts from dispatches where round_id = $1 and channel = 'kds'`, [roundId])
  expect([d.status, d.attempts]).toEqual(['pending', 0])
})
