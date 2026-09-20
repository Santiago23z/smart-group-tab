// Smart Group Tab — browser test helpers.
//
// Every spec gets its OWN table. That is not tidiness: `sessions_one_live_per_table`
// allows one live session per table, so two specs sharing a table would be racing
// each other for a tab rather than testing anything. A fresh table per spec means
// each one opens a clean session, and the specs can run in any order.

import pg from 'pg'
import { expect } from '@playwright/test'

const VENUE = '00000000-0000-4000-8000-000000000001'

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://santiagozapata@localhost:5432/smart_group_tab',
  max: 4,
})

let seq = 0

/** A table nobody else is sitting at. Returns its QR token. */
export async function freshTable(name) {
  const token = `qr-e2e-${name}-${Date.now().toString(36)}-${seq++}`
  await pool.query(
    `insert into tables (venue_id, label, qr_token) values ($1, $2, $3)`,
    [VENUE, `E2E ${token}`, token]
  )
  return token
}

export const sql = (text, params) => pool.query(text, params).then((r) => r.rows)
export const closePool = () => pool.end()

/**
 * Open the app as one diner and sit down at the table.
 * `page` is a fresh browser context, so localStorage is empty — which is what a
 * second phone scanning the same QR actually is.
 */
export async function joinAs(page, qrToken, nickname) {
  await page.goto(`/t/${qrToken}`)
  await page.fill('#nickname', nickname)
  await page.click('#join-form button[type=submit]')
  await expect(page.locator('#table')).toBeVisible()
  await expect(page.locator('button[data-add]').first()).toBeVisible()
}

/** Tap the + next to a product by its name on the menu. */
export async function order(page, productName) {
  const row = page.locator('#menu-list .row', { hasText: productName }).first()
  await row.locator('button[data-add]').tap()
  await expect(page.locator('#toast')).toContainText('Agregado')
}

export const openCart = (page) => page.locator('.tabs button', { hasText: 'Cuenta' }).tap()
export const openMenu = (page) => page.locator('.tabs button', { hasText: 'Carta' }).tap()

/** The app polls every 2s; give a server-driven change a beat to land. */
export const settled = (page) => page.waitForTimeout(2600)
