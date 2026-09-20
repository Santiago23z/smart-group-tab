// Smart Group Tab — the diner's screen, in a real browser, on a real table.
//
// These are the tests nothing else in the repo does. The 88 node tests prove the
// ledger is correct; none of them prove a diner can reach it. A CSS rule that
// left three full-screen overlays permanently on top shipped in the first commit
// and every one of those 88 stayed green.

import { test, expect } from '@playwright/test'
import { freshTable, joinAs, order, openCart, openMenu, settled, sql, closePool } from './helpers.mjs'

test.afterAll(closePool)

// ---------------------------------------------------------------------------
// What you see before you have done anything
// ---------------------------------------------------------------------------
test('the page opens on the nickname screen with nothing covering it', async ({ page }) => {
  const qr = await freshTable('open')
  await page.goto(`/t/${qr}`)

  await expect(page.locator('#join')).toBeVisible()
  await expect(page.locator('#nickname')).toBeVisible()

  // The regression. Each of these is toggled only through the `hidden` attribute,
  // and each has an author `display` rule that silently outranked it.
  await expect(page.locator('#pay')).toBeHidden()
  await expect(page.locator('#sheet')).toBeHidden()
  await expect(page.locator('#bar')).toBeHidden()
  await expect(page.locator('#table')).toBeHidden()

  // Not just invisible — actually reachable. If an overlay were still on top,
  // the nickname field would be there and untappable.
  await page.locator('#nickname').tap()
  await expect(page.locator('#nickname')).toBeFocused()
})

test('a nickname already taken at the table is refused, not silently renamed', async ({ browser }) => {
  const qr = await freshTable('dup')
  const first = await browser.newContext()
  const second = await browser.newContext()

  await joinAs(await first.newPage(), qr, 'Santi')

  const p2 = await second.newPage()
  await p2.goto(`/t/${qr}`)
  await p2.fill('#nickname', 'Santi')
  await p2.click('#join-form button[type=submit]')

  await expect(p2.locator('#join-error')).toBeVisible()
  await expect(p2.locator('#join-error')).toContainText('apodo')
  await expect(p2.locator('#table')).toBeHidden()

  await first.close()
  await second.close()
})

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------
test('ordering a product puts it in the cart at the price the menu showed', async ({ page }) => {
  const qr = await freshTable('order')
  await joinAs(page, qr, 'Ana')

  await order(page, 'Picada para compartir')
  await openCart(page)

  const cart = page.locator('#cart-list')
  await expect(cart).toContainText('Picada para compartir')
  // 32.000 + 8% tax, computed by the database and never by the browser.
  await expect(cart).toContainText('$34.560')
  await expect(page.locator('#cart-count')).toHaveText('1')
})

test('an item can be removed while the round is still a draft', async ({ page }) => {
  const qr = await freshTable('void')
  await joinAs(page, qr, 'Ana')
  await order(page, 'Hamburguesa de la casa')
  await openCart(page)

  await expect(page.locator('#cart-count')).toHaveText('1')
  await page.locator('#cart-list button[data-void]').first().tap()

  await expect(page.locator('#cart-count')).toHaveText('0')
  await expect(page.locator('#cart-list')).toContainText('Nada pedido todavía')
})

// ---------------------------------------------------------------------------
// The whole point: more than one phone
// ---------------------------------------------------------------------------
test('two phones at one table share one cart and see each other', async ({ browser }) => {
  const qr = await freshTable('two')
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()

  await joinAs(a, qr, 'Santi')
  await joinAs(b, qr, 'Cachetona')

  // Each phone is told who else is at the table.
  await expect(a.locator('#who')).toContainText('Cachetona')
  await expect(b.locator('#who')).toContainText('Santi')

  // What A orders, B sees — without B doing anything.
  await order(a, 'Tabla de quesos')
  await openCart(b)
  await expect(b.locator('#cart-list')).toContainText('Tabla de quesos', { timeout: 8000 })

  // And the reverse, into the same round. B is on the cart tab, so go back first.
  await openMenu(b)
  await order(b, 'Ceviche de camarón')
  await openCart(a)
  await expect(a.locator('#cart-list')).toContainText('Ceviche de camarón', { timeout: 8000 })
  await expect(a.locator('#cart-count')).toHaveText('2')

  const rounds = await sql(
    `select count(*) as n from rounds r
       join sessions s on s.id = r.session_id
       join tables t on t.id = s.table_id
      where t.qr_token = $1`, [qr])
  expect(Number(rounds[0].n)).toBe(1)

  await ctxA.close()
  await ctxB.close()
})

test('an item can be split between two people', async ({ browser }) => {
  const qr = await freshTable('share')
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()

  await joinAs(a, qr, 'Santi')
  await joinAs(b, qr, 'Cachetona')

  await order(a, 'Picada para compartir')
  await openCart(a)

  await a.locator('#cart-list button[data-share]').first().tap()
  await expect(a.locator('#sheet')).toBeVisible()
  // Tick everyone at the table.
  for (const cb of await a.locator('#sheet-people input[type=checkbox]').all()) await cb.check()
  await a.locator('#sheet-save').tap()

  await expect(a.locator('#sheet')).toBeHidden()
  await expect(a.locator('#cart-list')).toContainText('Santi')
  await expect(a.locator('#cart-list')).toContainText('Cachetona')

  // 34.560 split two ways, exactly, with no drift.
  const shares = await sql(
    `select s.owed_amount from cart_item_shares s
       join rounds r on r.id = s.round_id
       join sessions se on se.id = r.session_id
       join tables t on t.id = se.table_id
      where t.qr_token = $1 order by s.owed_amount`, [qr])
  expect(shares.map((s) => Number(s.owed_amount))).toEqual([17280, 17280])

  await ctxA.close()
  await ctxB.close()
})

// ---------------------------------------------------------------------------
// Closing, freezing, overflowing, paying
// ---------------------------------------------------------------------------
test('closing a round freezes the cart and asks for money', async ({ page }) => {
  const qr = await freshTable('close')
  await joinAs(page, qr, 'Ana')
  await order(page, 'Hamburguesa de la casa')
  await openCart(page)

  await page.locator('button[data-close="as_ordered"]').tap()
  await expect(page.locator('#toast')).toContainText('cobro')

  // The cart is frozen: the per-item actions are gone.
  await expect(page.locator('#round-actions')).toContainText('En cobro')
  await expect(page.locator('#cart-list button[data-void]')).toHaveCount(0)
  await expect(page.locator('#cart-list button[data-share]')).toHaveCount(0)

  // And the bottom bar now offers to pay.
  await expect(page.locator('#bar')).toBeVisible()
  await expect(page.locator('#bar-action')).toContainText('Pagar')
})

test('ordering during collection overflows into a new round', async ({ page }) => {
  const qr = await freshTable('overflow')
  await joinAs(page, qr, 'Ana')
  await order(page, 'Hamburguesa de la casa')
  await openCart(page)
  await page.locator('button[data-close="as_ordered"]').tap()
  await expect(page.locator('#round-actions')).toContainText('En cobro')

  // Order again while round 1 is still being paid for.
  await openMenu(page)
  await order(page, 'Ceviche de camarón')
  await settled(page)

  const rounds = await sql(
    `select r.round_number, r.status from rounds r
       join sessions s on s.id = r.session_id
       join tables t on t.id = s.table_id
      where t.qr_token = $1 order by r.round_number`, [qr])

  expect(rounds.map((r) => [Number(r.round_number), r.status])).toEqual([
    [1, 'locked_for_payment'],
    [2, 'draft'],
  ])

  // Round 1's total did not move — live reservations point at it.
  await openCart(page)
  await expect(page.locator('#other-rounds')).toContainText('Ronda 1')
})

test('paying the whole balance fires the kitchen exactly once', async ({ page }) => {
  const qr = await freshTable('pay')
  await joinAs(page, qr, 'Ana')
  await order(page, 'Hamburguesa de la casa')
  await openCart(page)
  await page.locator('button[data-close="as_ordered"]').tap()
  await expect(page.locator('#bar')).toBeVisible()

  await page.locator('#bar-action').tap()
  await expect(page.locator('#pay')).toBeVisible()
  // The tip is decided before the claim, never after.
  await expect(page.locator('#tip')).toBeVisible()
  await page.fill('#tip', '3000')
  await page.locator('#pay-confirm').tap()

  await expect(page.locator('#pay')).toBeHidden({ timeout: 15000 })
  await expect(page.locator('#round-actions')).toContainText('Pedido en cocina', { timeout: 15000 })

  const [round] = await sql(
    `select r.status, r.dispatched_at is not null as fired,
            (select count(*) from dispatches d where d.round_id = r.id) as dispatches
       from rounds r
       join sessions s on s.id = r.session_id
       join tables t on t.id = s.table_id
      where t.qr_token = $1 and r.round_number = 1`, [qr])

  expect(round.status).toBe('paid_and_dispatched')
  expect(round.fired).toBe(true)
  expect(Number(round.dispatches)).toBe(2)

  // The tip rode along with the payment but never counted toward releasing food.
  const [c] = await sql(
    `select c.order_amount, c.tip_amount from contributions c
       join rounds r on r.id = c.round_id
       join sessions s on s.id = r.session_id
       join tables t on t.id = s.table_id
      where t.qr_token = $1`, [qr])
  expect(Number(c.tip_amount)).toBe(3000)
  expect(Number(c.order_amount)).toBe(30240)
})

test('a big tip does not buy the food: one unpaid share still holds the kitchen', async ({ browser }) => {
  const qr = await freshTable('tip')
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()

  await joinAs(a, qr, 'Santi')
  await joinAs(b, qr, 'Cachetona')

  // One 34.560 item split two ways: 17.280 each.
  await order(a, 'Picada para compartir')
  await openCart(a)
  await a.locator('#cart-list button[data-share]').first().tap()
  for (const cb of await a.locator('#sheet-people input[type=checkbox]').all()) await cb.check()
  await a.locator('#sheet-save').tap()
  await expect(a.locator('#sheet')).toBeHidden()

  await a.locator('button[data-close="as_ordered"]').tap()
  await expect(a.locator('#bar')).toBeVisible()

  // Santi pays his half plus a tip far bigger than the whole round.
  await a.locator('#bar-action').tap()
  await expect(a.locator('#pay')).toBeVisible()
  await a.fill('#tip', '50000')
  await a.locator('#pay-confirm').tap()
  await expect(a.locator('#pay')).toBeHidden({ timeout: 15000 })

  const [round] = await sql(
    `select r.status, r.dispatched_at is not null as fired,
            round_total(r.id) as total,
            (select coalesce(sum(c.order_amount + c.tip_amount), 0) from contributions c
              where c.round_id = r.id) as collected,
            (select count(*) from dispatches d where d.round_id = r.id) as dispatches
       from rounds r
       join sessions s on s.id = r.session_id
       join tables t on t.id = s.table_id
      where t.qr_token = $1`, [qr])

  // More money is in the till than the round is worth...
  expect(Number(round.collected)).toBeGreaterThan(Number(round.total))
  // ...and the kitchen has still heard nothing, because Cachetona's share is unpaid.
  expect(round.status).toBe('locked_for_payment')
  expect(round.fired).toBe(false)
  expect(Number(round.dispatches)).toBe(0)

  // And the screen says so rather than implying the order is on its way.
  await expect(a.locator('#round-actions')).toContainText('En cobro')

  await ctxA.close()
  await ctxB.close()
})

// ---------------------------------------------------------------------------
// Coming back
// ---------------------------------------------------------------------------
test('a table that no longer exists sends you back to the QR, not to a dead screen', async ({ page }) => {
  const qr = await freshTable('stale')
  await joinAs(page, qr, 'Ana')

  // What a phone is left holding after the venue's session is gone — closed,
  // rebuilt, or wiped. The remembered ids simply stop resolving.
  await page.evaluate((k) => {
    localStorage.setItem(k, JSON.stringify({
      sessionId: '11111111-1111-4111-8111-111111111111',
      participantId: '22222222-2222-4222-8222-222222222222',
      nickname: 'Ana',
    }))
  }, `sgt:${qr}`)

  await page.reload()

  // The diner must land somewhere they can act, not on an empty table screen
  // with no menu and no way back.
  await expect(page.locator('#join')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('#nickname')).toBeVisible()
  await expect(page.locator('#table')).toBeHidden()
  await expect(page.locator('#join-error')).toBeVisible()

  // And the dead identity is not kept around to fail again on the next load.
  const stored = await page.evaluate((k) => localStorage.getItem(k), `sgt:${qr}`)
  expect(stored).toBeNull()

  // Joining again works. A new nickname, because the real Ana is still seated
  // in the session this phone had merely lost track of.
  await page.fill('#nickname', 'Ana de nuevo')
  await page.click('#join-form button[type=submit]')
  await expect(page.locator('#table')).toBeVisible()
  await expect(page.locator('button[data-add]').first()).toBeVisible()
})

test('reloading keeps you at the table without asking again', async ({ page }) => {
  const qr = await freshTable('reload')
  await joinAs(page, qr, 'Ana')
  await order(page, 'Ceviche de camarón')

  await page.reload()

  await expect(page.locator('#table')).toBeVisible()
  await expect(page.locator('#join')).toBeHidden()
  await openCart(page)
  await expect(page.locator('#cart-list')).toContainText('Ceviche de camarón')
})
