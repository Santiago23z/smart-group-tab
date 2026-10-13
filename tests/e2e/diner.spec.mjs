// Smart Group Tab — the diner's screen, in a real browser, on a real table.
//
// These are the tests nothing else in the repo does. The 88 node tests prove the
// ledger is correct; none of them prove a diner can reach it. A CSS rule that
// left three full-screen overlays permanently on top shipped in the first commit
// and every one of those 88 stayed green.

import { test, expect } from '@playwright/test'
import { freshTable, freshOpenTabTable, joinAs, enterTable, order, openCart, openMenu, settled, sql, closePool } from './helpers.mjs'

test.afterAll(closePool)

// Phones a test opened with browser.newContext() are its own to close. Left
// open, every one keeps polling and animating in the one shared WebKit; a
// dozen of them by the end of the file froze the whole browser mid-tap.
test.afterEach(async ({ browser, page }) => {
  for (const ctx of browser.contexts()) if (ctx !== page.context()) await ctx.close()
})

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
  await enterTable(p2, qr, 'Santi')

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

  // Polls that change nothing leave the row alone: rewriting it would replay
  // its entrance and drop a tap in progress.
  await cart.locator('.row.item').evaluate((row) => { row.dataset.probe = 'same-element' })
  await settled(page)
  await settled(page)
  await expect(cart.locator('.row.item')).toHaveAttribute('data-probe', 'same-element')
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

test('a checkout Wompi refuses is shown as an error, never settled as simulated', async ({ page }) => {
  // The server under test has no Wompi keys, so its real answer would be
  // `wompi_not_configured`. Pretend the keys are there and the checkout was
  // refused for another reason — the case that used to fall through to
  // /api/dev/pay and record a payment that never happened.
  let simulated = 0
  await page.route('**/api/payments/intent', (route) =>
    route.fulfill({ json: { status: 'rejected', reason: 'reservation_not_payable' } }))
  await page.route('**/api/dev/pay', (route) => { simulated++; return route.continue() })

  const qr = await freshTable('refused')
  await joinAs(page, qr, 'Ana')
  await order(page, 'Hamburguesa de la casa')
  await openCart(page)
  await page.locator('button[data-close="as_ordered"]').tap()
  await page.locator('#bar-action').tap()
  await page.locator('#pay-confirm').tap()

  await expect(page.locator('#pay-error')).toBeVisible()
  await expect(page.locator('#pay-error')).toContainText('venció')
  expect(simulated).toBe(0)

  const [round] = await sql(
    `select r.status from rounds r
       join sessions s on s.id = r.session_id
       join tables t on t.id = s.table_id
      where t.qr_token = $1 and r.round_number = 1`, [qr])
  expect(round.status).toBe('locked_for_payment')
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
  await enterTable(page, qr, 'Ana de nuevo')
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

// Back from Wompi, the page checks the transaction at once instead of waiting
// for a webhook that may never come. The server's answer is faked here: what is
// under test is that the page asks, says the right thing, and cleans its URL.
for (const [outcome, status, text] of [
  ['approved', 'settled', 'Pago aprobado'],
  ['approved', 'credited', 'saldo a favor'],
  ['declined', 'released', 'rechazado'],
  ['pending', undefined, 'procesando'],
]) {
  test(`back from Wompi with a ${outcome} (${status}) payment, the page says so`, async ({ page }) => {
    const asked = []
    await page.route('**/api/payments/reconcile', async (route) => {
      asked.push(route.request().postDataJSON())
      return route.fulfill({ json: { outcome, status } })
    })

    const qr = await freshTable(`return-${outcome}-${status}`)
    await joinAs(page, qr, 'Ana')
    await page.goto(`/t/${qr}?id=tx-from-wompi`)

    await expect(page.locator('#toast')).toContainText(text)
    expect(asked).toEqual([{ transaction_id: 'tx-from-wompi' }])
    // A reload must not ask again, so the id leaves the address bar.
    expect(new URL(page.url()).search).toBe('')
  })
}

// An open tab from start to finish on two phones: two rounds go to the kitchen
// unpaid, the table asks for the bill, each pays their part in one payment,
// and the table closes.
test('an open tab: two rounds, the bill, one payment each, and the table closes', async ({ browser }) => {
  const qr = await freshOpenTabTable('tab')
  const a = await (await browser.newContext()).newPage()
  const b = await (await browser.newContext()).newPage()
  await joinAs(a, qr, 'Ana')
  await joinAs(b, qr, 'Beto')

  for (let round = 1; round <= 2; round++) {
    await order(a, 'Cerveza OT')
    await order(b, 'Papas OT')
    await openCart(a)
    await a.locator('button[data-close="as_ordered"]').tap()
    await expect(a.locator('#toast')).toContainText('Pedido enviado a cocina')
    await openMenu(a)
  }

  await openCart(a)
  await a.locator('#ask-bill').tap()
  await expect(a.locator('#bill')).toContainText('Cuenta pedida')
  await expect(a.locator('#bill')).toContainText('$46.000')
  // Nothing more can be ordered, so nothing may say otherwise.
  await expect(a.locator('#round-actions')).not.toContainText('seguir pidiendo')

  // Ana: one payment for both her beers.
  await expect(a.locator('#bar-amount')).toHaveText('$18.000')
  await a.locator('#bar-action').tap()
  await a.locator('#pay-confirm').tap()
  await expect(a.locator('#toast')).toContainText('Pagado')

  // Beto, on his phone: his part is what is left, and paying it closes the table.
  await openCart(b)
  await expect(b.locator('#bar-amount')).toHaveText('$28.000', { timeout: 8000 })
  await b.locator('#bar-action').tap()
  await b.locator('#pay-confirm').tap()
  await expect(b.locator('#bill')).toContainText('Mesa cerrada', { timeout: 8000 })
  await expect(a.locator('#bill')).toContainText('Mesa cerrada', { timeout: 8000 })

  const [s] = await sql(
    `select s.status from sessions s join tables t on t.id = s.table_id where t.qr_token = $1`, [qr])
  expect(s.status).toBe('closed')
})

// Dish photos: shown small, downloaded once, enlarged on tap.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('a dish photo shows small, is downloaded once across polls, and opens large on tap', async ({ page }) => {
  const qr = await freshOpenTabTable('photo')
  const [{ id: dishId, venue_id: venueId }] = await sql(
    `select p.id, p.venue_id from products p join tables t on t.venue_id = p.venue_id
      where t.qr_token = $1 and p.name = 'Cerveza OT'`, [qr])
  await sql(`select staff_set_photo($1, $2, $3, $3, 'image/png')`, [venueId, dishId, PNG_1PX])

  const thumbs = []
  page.on('request', (r) => { if (r.url().includes('/photos/') && r.url().endsWith('thumb.jpg')) thumbs.push(r.url()) })

  await joinAs(page, qr, 'Ana')
  const beer = page.locator('#menu-list .row', { hasText: 'Cerveza OT' })
  const fries = page.locator('#menu-list .row', { hasText: 'Papas OT' })
  await expect(beer.locator('img')).toHaveAttribute('src', new RegExp(`/photos/${dishId}/[0-9a-f]{16}/thumb\\.jpg`))
  await expect(fries.locator('img')).toHaveCount(0)

  // Mark the very element on screen; a redraw would replace it (and re-decode,
  // which is the flicker), even when the browser's cache saves the download.
  await beer.locator('img').evaluate((img) => { img.dataset.probe = 'same-element' })
  await settled(page)
  await settled(page)
  await expect(beer.locator('img')).toHaveAttribute('data-probe', 'same-element')
  expect(thumbs.length).toBe(1)

  await beer.locator('button.thumb').tap()
  await expect(page.locator('#photo-view')).toBeVisible()
  await expect(page.locator('#photo-large')).toHaveAttribute('src', /large\.jpg$/)
  await page.locator('#photo-view').tap()
  await expect(page.locator('#photo-view')).toBeHidden()
})

test('a dish description shows under its name, opens whole on tap, and goes with the large photo', async ({ page }) => {
  const qr = await freshOpenTabTable('description')
  const [{ id: dishId, venue_id: venueId }] = await sql(
    `select p.id, p.venue_id from products p join tables t on t.venue_id = p.venue_id
      where t.qr_token = $1 and p.name = 'Cerveza OT'`, [qr])
  const long = 'Cerveza roja de la casa, servida bien fría en vaso escarchado, con limón y sal al lado. ' +
    'Pregunta por la de temporada: cambia cada mes y viene en botella de 330 ml.'
  await sql(`update products set description = $2 where id = $1`, [dishId, long])
  await sql(`select staff_set_photo($1, $2, $3, $3, 'image/png')`, [venueId, dishId, PNG_1PX])

  await joinAs(page, qr, 'Ana')
  const beer = page.locator('#menu-list .row', { hasText: 'Cerveza OT' })
  const desc = beer.locator('button.desc')
  const text = desc.locator('span')
  await expect(desc).toHaveText(long)
  await expect(page.locator('#menu-list .row', { hasText: 'Papas OT' }).locator('button.desc')).toHaveCount(0)

  // Two lines at first; whole after a tap, and still whole after the next polls.
  const clamped = await text.evaluate((el) => el.clientHeight)
  expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await desc.tap()
  await settled(page)
  expect(await text.evaluate((el) => el.clientHeight)).toBeGreaterThan(clamped)
  expect(await text.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)

  await beer.locator('button.thumb').tap()
  await expect(page.locator('#photo-name')).toHaveText('Cerveza OT')
  await expect(page.locator('#photo-desc')).toHaveText(long)
})

// ---------------------------------------------------------------------------
// Alone at the table: nothing to share, one button
// ---------------------------------------------------------------------------
test('alone at a table that pays each round: no "Compartir", one "Pedir y pagar"', async ({ page }) => {
  const qr = await freshTable('solo')
  await joinAs(page, qr, 'Ana')
  await order(page, 'Hamburguesa de la casa')
  await openCart(page)

  await expect(page.locator('#cart-list .row.item')).toHaveCount(1)
  await expect(page.locator('#cart-list button[data-share]')).toHaveCount(0)
  await expect(page.locator('#round-actions button')).toHaveCount(1)
  await expect(page.locator('#round-actions button')).toHaveText('Pedir y pagar')

  // It closes as ordered: Ana owes what she added, and pays it.
  await page.locator('#round-actions button').tap()
  await expect(page.locator('#bar-action')).toHaveText('Pagar lo mío')
})

test('alone at a tab table the button says "Enviar a la cocina"', async ({ page }) => {
  const qr = await freshOpenTabTable('solo-tab')
  await joinAs(page, qr, 'Ana')
  await order(page, 'Papas OT')
  await openCart(page)
  await expect(page.locator('#round-actions button')).toHaveText('Enviar a la cocina')
  await page.locator('#round-actions button').tap()
  await expect(page.locator('#round-actions')).toContainText('Pedido en cocina')
})

test('when a second diner joins, both phones offer to share and to split again', async ({ browser }) => {
  const qr = await freshTable('solo-join')
  const a = await (await browser.newContext()).newPage()
  await joinAs(a, qr, 'Ana')
  await order(a, 'Picada para compartir')
  await openCart(a)
  await expect(a.locator('#cart-list button[data-share]')).toHaveCount(0)

  const b = await (await browser.newContext()).newPage()
  await joinAs(b, qr, 'Beto')
  await openCart(b)

  // Ana's phone catches up on its own: no reload.
  for (const phone of [a, b]) {
    await expect(phone.locator('#cart-list button[data-share]')).toHaveCount(1, { timeout: 8000 })
    await expect(phone.locator('#round-actions button[data-close="as_ordered"]')).toContainText('cada quien lo suyo')
    await expect(phone.locator('#round-actions button[data-close="equal"]')).toBeVisible()
  }
})

// ---------------------------------------------------------------------------
// The diner chooses how the table pays
// ---------------------------------------------------------------------------
test('alone, choosing "Abrir cuenta": the food goes to the kitchen unpaid, and she pays at the end', async ({ page }) => {
  const qr = await freshTable('elige-cuenta')
  await page.goto(`/t/${qr}`)
  await expect(page.locator('#pay-choice')).toBeVisible()
  // "Entrar" waits for a choice.
  await page.fill('#nickname', 'Ana')
  await expect(page.locator('#join-form button[type=submit]')).toBeDisabled()
  await page.locator('#pay-choice button[data-mode="open_tab"]').click()
  await page.click('#join-form button[type=submit]')
  await expect(page.locator('#table-mode')).toHaveText('Cuenta abierta · pagan al final')

  await order(page, 'Hamburguesa de la casa')
  await openCart(page)
  await page.locator('#round-actions button').tap()
  await expect(page.locator('#round-actions')).toContainText('Pedido en cocina')
  // Nothing was charged: what she owes is on the tab, payable whenever she likes.
  await expect(page.locator('#bar-label')).toHaveText('Lo tuyo hasta ahora')

  await page.locator('#ask-bill').tap()
  await page.locator('#bar-action').tap()
  await page.locator('#pay-confirm').tap()
  await expect(page.locator('#bill')).toContainText('Mesa cerrada', { timeout: 8000 })
})

test('paying each round, then switching: round 2 goes unpaid, and the bill holds round 2 only', async ({ page }) => {
  const qr = await freshTable('cambia')
  await joinAs(page, qr, 'Ana', 'pay_before_order')
  await expect(page.locator('#table-mode')).toHaveText('Pagan cada ronda')

  // Round 1, paid before the kitchen.
  await order(page, 'Hamburguesa de la casa')
  await openCart(page)
  await page.locator('#round-actions button').tap()
  await expect(page.locator('#bar')).toBeVisible()
  await page.locator('#bar-action').tap()
  await page.locator('#pay-confirm').tap()
  await expect(page.locator('#round-actions')).toContainText('Pedido en cocina', { timeout: 8000 })

  // Switch, with its confirmation.
  await page.locator('#switch-tab').tap()
  await expect(page.locator('#mode-switch')).toContainText('sin pagar')
  await page.locator('#switch-yes').tap()
  await expect(page.locator('#table-mode')).toHaveText('Cuenta abierta · pagan al final')
  // And the way back is offered.
  await expect(page.locator('#switch-tab')).toHaveText('Pasar a pagar cada ronda')

  // Round 2 goes straight to the kitchen.
  await openMenu(page)
  await order(page, 'Picada para compartir')
  await openCart(page)
  await expect(page.locator('#round-actions button')).toHaveText('Enviar a la cocina')
  await page.locator('#round-actions button').tap()
  await expect(page.locator('#toast')).toContainText('Pedido enviado a cocina')

  await page.locator('#ask-bill').tap()
  const [{ session_id: sessionId }] = await sql(
    `select s.id as session_id from sessions s join tables t on t.id = s.table_id where t.qr_token = $1`, [qr])
  const [{ r: tab }] = await sql(`select tab_summary($1) as r`, [sessionId])
  const [{ total: round2 }] = await sql(
    `select round_total(r.id) as total from rounds r where r.session_id = $1 and r.round_number = 2`, [sessionId])
  expect(Number(tab.total)).toBe(Number(round2))
})

test('a diner arriving at an open table is told how it pays, and is not asked', async ({ browser }) => {
  const qr = await freshTable('ya-abierta')
  await joinAs(await (await browser.newContext()).newPage(), qr, 'Ana', 'open_tab')
  const b = await (await browser.newContext()).newPage()
  await b.goto(`/t/${qr}`)
  await expect(b.locator('#join-form[data-ready]')).toHaveCount(1)
  await expect(b.locator('#pay-choice')).toBeHidden()
  await expect(b.locator('#join-mode')).toHaveText('Esta mesa tiene cuenta abierta: pagan al final.')
  await b.fill('#nickname', 'Beto')
  await b.click('#join-form button[type=submit]')
  await expect(b.locator('#table-mode')).toHaveText('Cuenta abierta · pagan al final')
})

// ---------------------------------------------------------------------------
// Changing how the table pays, from the pay sheet and back; paying early on a tab
// ---------------------------------------------------------------------------
test('from the pay sheet: "Seguir pidiendo y pagar todo al final" sends the round to the kitchen', async ({ page }) => {
  const qr = await freshTable('pagar-despues')
  await joinAs(page, qr, 'Ana', 'pay_before_order')
  await order(page, 'Hamburguesa de la casa')
  await openCart(page)
  await page.locator('#round-actions button').tap()
  await page.locator('#bar-action').tap()
  await expect(page.locator('#pay')).toBeVisible()

  await page.locator('#pay-later-ask').tap()
  await expect(page.locator('#pay-later-confirm')).toContainText('se va ya a la cocina')
  await page.locator('#pay-later-yes').tap()
  await expect(page.locator('#pay')).toBeHidden()
  await expect(page.locator('#table-mode')).toHaveText('Cuenta abierta · pagan al final')
  await expect(page.locator('#round-actions')).toContainText('Pedido en cocina')

  const [r] = await sql(
    `select r.status, (select count(*) from dispatches d where d.round_id = r.id) as dispatches
       from rounds r join sessions s on s.id = r.session_id join tables t on t.id = s.table_id
      where t.qr_token = $1 and r.round_number = 1`, [qr])
  expect([r.status, Number(r.dispatches)]).toEqual(['paid_and_dispatched', 2])
})

test('a tab table switches back to paying each round: the next round asks for payment', async ({ page }) => {
  const qr = await freshOpenTabTable('vuelve')
  await joinAs(page, qr, 'Ana', 'open_tab')
  await openCart(page)
  await expect(page.locator('#switch-tab')).toHaveText('Pasar a pagar cada ronda')
  await page.locator('#switch-tab').tap()
  await expect(page.locator('#mode-switch')).toContainText('cada ronda se paga antes')
  await page.locator('#switch-yes').tap()
  await expect(page.locator('#table-mode')).toHaveText('Pagan cada ronda')

  await openMenu(page)
  await order(page, 'Papas OT')
  await openCart(page)
  await expect(page.locator('#round-actions button')).toHaveText('Pedir y pagar')
  await page.locator('#round-actions button').tap()
  await expect(page.locator('#bar')).toBeVisible()
  await expect(page.locator('#round-actions')).toContainText('En cobro')
})

test('on a tab, Carla pays her part before the bill and Ana keeps ordering', async ({ browser }) => {
  const qr = await freshOpenTabTable('temprano')
  const ana = await (await browser.newContext()).newPage()
  const carla = await (await browser.newContext()).newPage()
  await joinAs(ana, qr, 'Ana', 'open_tab')
  await joinAs(carla, qr, 'Carla')
  await order(ana, 'Cerveza OT')
  await order(carla, 'Papas OT')
  await openCart(ana)
  await ana.locator('button[data-close="as_ordered"]').tap()
  await expect(ana.locator('#toast')).toContainText('Pedido enviado a cocina')

  // Carla: her part so far, payable now, with no "pay the waiter" before the bill.
  await openCart(carla)
  await expect(carla.locator('#bar-label')).toHaveText('Lo tuyo hasta ahora', { timeout: 8000 })
  await expect(carla.locator('#bar-amount')).toHaveText('$14.000')
  await carla.locator('#bar-action').tap()
  await expect(carla.locator('#cash-options')).toBeHidden()
  await carla.locator('#pay-confirm').tap()
  await expect(carla.locator('#toast')).toContainText('Pagado')

  // Nobody asked for the bill: Ana orders again.
  await openMenu(ana)
  await order(ana, 'Cerveza OT')
  await openCart(ana)
  await ana.locator('button[data-close="as_ordered"]').tap()
  await expect(ana.locator('#toast')).toContainText('Pedido enviado a cocina')
  const [s] = await sql(
    `select s.bill_requested_at, tab_summary(s.id) as tab from sessions s join tables t on t.id = s.table_id where t.qr_token = $1`, [qr])
  expect(s.bill_requested_at).toBeNull()
  expect(Number(s.tab.total)).toBe(18_000)
})

test('the tick after adding sits dead centre in its button', async ({ page }) => {
  const qr = await freshTable('tick')
  await joinAs(page, qr, 'Ana')
  const button = page.locator('#menu-list .row', { hasText: 'Hamburguesa de la casa' }).locator('button[data-add]')
  await button.tap()
  await expect(button).toHaveClass(/done/)
  await expect(button.locator('.tick')).toHaveCSS('opacity', '1')
  const [b, t] = await Promise.all([button.boundingBox(), button.locator('.tick').boundingBox()])
  expect(Math.abs((b.x + b.width / 2) - (t.x + t.width / 2))).toBeLessThan(1)
  expect(Math.abs((b.y + b.height / 2) - (t.y + t.height / 2))).toBeLessThan(1)
})
