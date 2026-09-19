// Smart Group Tab — the diner's screen.
//
// Every number shown here comes from the server. Nothing about money is computed
// in the browser, and nothing is rendered optimistically: with an irreversible
// payment rail, a balance that is momentarily wrong is worse than a balance that
// is momentarily late.
//
// Live updates are polling, which is a placeholder. With Supabase in place this
// becomes a Realtime subscription over the same /api/state shape — and it would
// still need this same reconcile-on-focus, because a phone that slept through a
// round must not trust what it last saw.

const $ = (id) => document.getElementById(id)
const api = async (path, body) => {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? res.statusText)
  return res.json()
}

const money = (n) => `$${Number(n ?? 0).toLocaleString('es-CO')}`
const qrToken = decodeURIComponent(location.pathname.replace(/^\/t\//, '')) || 'qr-test-mesa-12'
const storeKey = `sgt:${qrToken}`

let me = JSON.parse(localStorage.getItem(storeKey) ?? 'null')
let state = null
let sharingItemId = null

function toast(message, bad = false) {
  const el = $('toast')
  el.textContent = message
  el.classList.toggle('bad', bad)
  el.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (el.hidden = true), 2800)
}

/** The RPCs answer `{status:'rejected', reason}` for ordinary refusals. */
const REASONS = {
  nickname_taken: 'Ese apodo ya está en la mesa. Probá con otro.',
  unknown_table: 'Ese QR no corresponde a ninguna mesa activa.',
  shares_taken: 'Alguien más ya tomó eso. Mirá el saldo actualizado.',
  nothing_available: 'No queda nada por cubrir.',
  round_not_collectable: 'Esta ronda ya no está en cobro.',
  round_not_editable: 'La ronda está en cobro: ya no se puede cambiar.',
  empty_round: 'No hay nada pedido todavía.',
  amount_exceeds_outstanding: 'Es más de lo que falta por cubrir.',
  participant_not_in_session: 'No estás en esta mesa.',
  session_closed: 'La mesa ya se cerró.',
  wompi_not_configured: 'Falta configurar Wompi. Usá el pago simulado.',
}
const explain = (r) => REASONS[r?.reason] ?? r?.reason ?? 'No se pudo.'

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------
$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const nickname = $('nickname').value.trim()
  if (!nickname) return

  try {
    const result = await api('/api/join', { qr_token: qrToken, nickname })
    if (result.status !== 'joined') {
      $('join-error').textContent = explain(result)
      $('join-error').hidden = false
      return
    }
    me = {
      sessionId: result.session_id,
      participantId: result.participant_id,
      nickname,
    }
    localStorage.setItem(storeKey, JSON.stringify(me))
    await refresh()
    show('table')
  } catch (err) {
    $('join-error').textContent = err.message
    $('join-error').hidden = false
  }
})

function show(screen) {
  $('join').hidden = screen !== 'join'
  $('table').hidden = screen !== 'table'
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn))
    $('tab-menu').hidden = btn.dataset.tab !== 'menu'
    $('tab-cart').hidden = btn.dataset.tab !== 'cart'
  })
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
const nameOf = (id) => state?.participants.find((p) => p.id === id)?.nickname ?? '—'
const currentRound = () =>
  state?.rounds.find((r) => r.status === 'draft') ??
  state?.rounds.find((r) => r.status === 'pending_payment') ??
  state?.rounds.at(-1) ?? null

function render() {
  if (!state) return

  $('table-label').textContent = `${state.venue.name} · ${state.table.label}`
  $('who').innerHTML = state.participants
    .map((p) => `<span class="${p.id === me.participantId ? 'me' : ''}">${escape(p.nickname)}</span>`)
    .join('')

  const round = currentRound()
  $('round-label').textContent = round ? `Ronda ${round.number}` : 'Mesa'

  renderMenu()
  renderCart(round)
  renderBar(round)
}

function renderMenu() {
  const byCategory = {}
  for (const p of state.menu) (byCategory[p.category ?? 'Carta'] ??= []).push(p)

  $('menu-list').innerHTML = Object.entries(byCategory)
    .map(([category, items]) => `
      <p class="cat">${escape(category)}</p>
      ${items.map((p) => `
        <div class="row">
          <div class="grow">
            <div class="name">${escape(p.name)}</div>
            <div class="sub">${money(p.unit_price)}${Number(p.tax_rate) ? ' + imp.' : ''}</div>
          </div>
          <button class="add" data-add="${p.id}" aria-label="Agregar ${escape(p.name)}">+</button>
        </div>`).join('')}`)
    .join('')
}

function renderCart(round) {
  const items = round?.items ?? []
  const badge = $('cart-count')
  badge.textContent = items.length
  badge.toggleAttribute('data-zero', items.length === 0)

  const editable = round?.status === 'draft'

  $('cart-list').innerHTML = items.length === 0
    ? `<p class="empty">Nada pedido todavía.<br>Agregá algo de la carta.</p>`
    : items.map((item) => `
        <div class="row item">
          <div class="grow">
            <div class="top">
              <span class="name grow">${escape(item.name)}${item.quantity > 1 ? ` ×${item.quantity}` : ''}</span>
              <span class="price">${money(item.line_total)}</span>
            </div>
            <div class="shares">
              ${item.shares.map((s) => `
                <span class="chip ${s.settled ? 'settled' : s.held ? 'held' : ''}">
                  ${escape(nameOf(s.participant_id))} ${money(s.owed_amount)}
                </span>`).join('')}
            </div>
            ${editable ? `
              <div class="item-actions">
                <button class="ghost" data-share="${item.id}">Compartir</button>
                <button class="ghost" data-void="${item.id}">Quitar</button>
              </div>` : ''}
          </div>
        </div>`).join('')

  renderOwed(round)
  renderRoundActions(round)
  renderOtherRounds()
}

function renderOwed(round) {
  if (!round || round.items.length === 0) return ($('owed').innerHTML = '')

  const totals = new Map()
  for (const item of round.items) {
    for (const s of item.shares) {
      const entry = totals.get(s.participant_id) ?? { owes: 0, settled: 0 }
      entry.owes += Number(s.owed_amount)
      if (s.settled) entry.settled += Number(s.owed_amount)
      totals.set(s.participant_id, entry)
    }
  }

  $('owed').innerHTML = `
    ${[...totals.entries()].map(([id, t]) => `
      <div class="line">
        <span>${escape(nameOf(id))}${id === me.participantId ? ' (vos)' : ''}</span>
        <span>
          ${money(t.owes)}
          <span class="state ${t.settled >= t.owes ? 'ok' : 'pending'}">
            ${t.settled >= t.owes ? '· pagado' : t.settled > 0 ? `· faltan ${money(t.owes - t.settled)}` : ''}
          </span>
        </span>
      </div>`).join('')}
    <div class="line total"><span>Total</span><span>${money(round.total)}</span></div>
    ${round.status === 'pending_payment'
      ? `<div class="line"><span class="muted">Sin cubrir</span><span class="muted">${money(round.outstanding)}</span></div>`
      : ''}`
}

function renderRoundActions(round) {
  const el = $('round-actions')
  if (!round) return (el.innerHTML = '')

  if (round.status === 'draft') {
    el.innerHTML = round.items.length === 0 ? '' : `
      <button data-close="as_ordered">Cerrar ronda · cada quien lo suyo</button>
      <button class="ghost" data-close="equal">Cerrar ronda · partes iguales</button>`
    return
  }

  if (round.status === 'pending_payment') {
    el.innerHTML = `
      <div class="banner">
        <strong>En cobro</strong>
        <span class="muted">
          ${state.session.service_mode === 'pay_before_order'
            ? 'La cocina no recibe nada hasta que esté cubierto el 100%.'
            : 'Faltan ' + money(round.outstanding) + '.'}
        </span>
      </div>`
    return
  }

  if (round.status === 'paid_and_dispatched') {
    el.innerHTML = `
      <div class="banner ok"><strong>Pedido en cocina</strong>
      <span class="muted">Ya podés seguir pidiendo: va a una ronda nueva.</span></div>`
    return
  }

  el.innerHTML = `<div class="banner"><strong>Necesita al mesero</strong>
    <span class="muted">Algo no cuadró y alguien del local tiene que resolverlo.</span></div>`
}

function renderOtherRounds() {
  const others = state.rounds.filter((r) => r.id !== currentRound()?.id)
  $('other-rounds').innerHTML = others.length === 0 ? '' : `
    <p class="cat">Rondas anteriores</p>
    ${others.map((r) => `
      <div class="row">
        <div class="grow"><div class="name">Ronda ${r.number}</div>
        <div class="sub">${r.status === 'paid_and_dispatched' ? 'en cocina' : r.status}</div></div>
        <span class="price">${money(r.total)}</span>
      </div>`).join('')}`
}

function renderBar(round) {
  const bar = $('bar')
  const reservation = state.my_reservation

  if (reservation) {
    bar.hidden = false
    $('bar-label').textContent = 'Reservado para vos'
    $('bar-amount').textContent = money(Number(reservation.order_amount) + Number(reservation.tip_amount))
    $('bar-action').textContent = 'Pagar ahora'
    $('bar-action').dataset.action = 'pay'
    return
  }

  if (round?.status !== 'pending_payment' || Number(round.outstanding) === 0) {
    bar.hidden = true
    return
  }

  const mine = round.items
    .flatMap((i) => i.shares)
    .filter((s) => s.participant_id === me.participantId && !s.held)
    .reduce((a, s) => a + Number(s.owed_amount), 0)

  bar.hidden = false
  $('bar-label').textContent = mine > 0 ? 'Tu parte' : 'Falta por cubrir'
  $('bar-amount').textContent = money(mine > 0 ? mine : round.outstanding)
  $('bar-action').textContent = mine > 0 ? 'Pagar lo mío' : 'Cubrir el resto'
  $('bar-action').dataset.action = mine > 0 ? 'my_items' : 'remaining'
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button')
  if (!btn) return

  try {
    if (btn.dataset.add) {
      const r = await api('/api/cart/add', {
        session_id: me.sessionId, participant_id: me.participantId,
        product_id: btn.dataset.add, quantity: 1,
      })
      if (r.status !== 'added') return toast(explain(r), true)
      toast('Agregado')
      await refresh()
    }

    if (btn.dataset.void) {
      const r = await api('/api/cart/void', {
        cart_item_id: btn.dataset.void, participant_id: me.participantId,
      })
      if (r.status !== 'voided') return toast(explain(r), true)
      await refresh()
    }

    if (btn.dataset.share) openSharing(btn.dataset.share)

    if (btn.dataset.close) {
      const r = await api('/api/round/close', {
        session_id: me.sessionId, participant_id: me.participantId,
        split_mode: btn.dataset.close,
      })
      if (r.status === 'rejected') return toast(explain(r), true)
      toast(r.status === 'dispatched' ? 'Pedido enviado a cocina' : 'Ronda en cobro')
      await refresh()
    }

    if (btn.id === 'bar-action') onBarAction()
    if (btn.id === 'sheet-cancel') $('sheet').hidden = true
    if (btn.id === 'sheet-save') await saveSharing()
    if (btn.id === 'pay-cancel') $('pay').hidden = true
    if (btn.id === 'pay-confirm') await confirmPayment()
  } catch (err) {
    toast(err.message, true)
  }
})

function openSharing(itemId) {
  sharingItemId = itemId
  const item = currentRound().items.find((i) => i.id === itemId)
  const owners = new Set(item.shares.map((s) => s.participant_id))

  $('sheet-title').textContent = item.name
  $('sheet-people').innerHTML = state.participants.map((p) => `
    <label class="person">
      <input type="checkbox" value="${p.id}" ${owners.has(p.id) ? 'checked' : ''}>
      <span>${escape(p.nickname)}</span>
    </label>`).join('')
  $('sheet').hidden = false
}

async function saveSharing() {
  const ids = [...$('sheet-people').querySelectorAll('input:checked')].map((i) => i.value)
  if (ids.length === 0) return toast('Elegí al menos a una persona', true)

  const r = await api('/api/cart/share', {
    cart_item_id: sharingItemId, participant_ids: ids, participant_id: me.participantId,
  })
  $('sheet').hidden = true
  if (r.status !== 'reshared') return toast(explain(r), true)
  toast(`Dividido entre ${ids.length}`)
  await refresh()
}

// The tip is part of the reservation, so it has to be known before we claim
// anything. Asking afterwards would mean cancelling a live hold and re-taking it
// — handing the shares back to the table for the length of a round trip, in a
// race the diner would have no idea they were in.
function onBarAction() {
  const round = currentRound()
  const reservation = state.my_reservation

  const amount = reservation
    ? Number(reservation.order_amount)
    : $('bar-action').dataset.action === 'my_items'
      ? round.items.flatMap((i) => i.shares)
          .filter((s) => s.participant_id === me.participantId && !s.held)
          .reduce((a, s) => a + Number(s.owed_amount), 0)
      : Number(round.outstanding)

  $('pay-amount').textContent = money(amount)
  $('pay-detail').textContent = reservation
    ? `Reservado hasta las ${new Date(reservation.expires_at).toLocaleTimeString('es-CO', {
        hour: '2-digit', minute: '2-digit',
      })}. Si no pagás, vuelve a quedar libre para la mesa.`
    : 'Se aparta para vos por 5 minutos mientras pagás.'
  $('tip').value = reservation ? reservation.tip_amount || 0 : 0
  $('tip').disabled = Boolean(reservation)
  $('pay-error').hidden = true
  $('pay').hidden = false
}

function payError(message) {
  $('pay-error').textContent = message
  $('pay-error').hidden = false
}

async function confirmPayment() {
  const round = currentRound()
  let reservation = state.my_reservation

  // Claim first, with the tip already decided.
  if (!reservation) {
    const claim = await api('/api/reserve', {
      round_id: round.id,
      participant_id: me.participantId,
      mode: $('bar-action').dataset.action,
      tip: Number($('tip').value || 0),
    })

    if (claim.status === 'rejected') {
      await refresh()
      return payError(explain(claim))
    }
    await refresh()
    reservation = state.my_reservation
    if (!reservation) return payError('La reserva no quedó registrada. Intentá de nuevo.')
  }

  const intent = await api('/api/payments/intent', { reservation_id: reservation.id })

  if (intent.status === 'created') {
    $('pay').hidden = true
    location.href = intent.checkout_url
    return
  }

  // No Wompi keys configured: settle through the same confirm_webhook a real
  // callback goes through, so dispatch and every invariant behave identically.
  const paid = await api('/api/dev/pay', { reservation_id: reservation.id })
  if (paid.status === 'rejected') return payError(explain(paid))

  $('pay').hidden = true
  await refresh()
  toast(paid.status === 'settled' ? 'Pagado' : `Pago: ${paid.status}`, paid.status !== 'settled')
}

// ---------------------------------------------------------------------------
// Polling, and reconciling whenever the phone comes back
// ---------------------------------------------------------------------------
async function refresh() {
  if (!me) return
  try {
    state = await api(`/api/state?session_id=${me.sessionId}&participant_id=${me.participantId}`)
    render()
  } catch {
    // A dropped request is normal in a bar. The next tick reconciles.
  }
}

setInterval(refresh, 2000)
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh())

if (me) {
  show('table')
  refresh()
} else {
  api(`/api/state?session_id=00000000-0000-0000-0000-000000000000`).catch(() => {})
  $('join-venue').textContent = 'Escaneaste la mesa'
  show('join')
}
