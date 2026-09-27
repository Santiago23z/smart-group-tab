// Smart Group Tab — the kitchen screen.
//
// Polls /kds/api/state, like the diner's screen polls /api/state, and renders
// it. Nothing is decided here: which tables need a human and why comes from
// staff_alerts() in SQL; this only turns it into words.
//
// The staff token arrives once as `#token=...`, moves to localStorage, and is
// wiped from the address bar. A hash rather than a query string, so it never
// reaches a server log.

const POLL_MS = 3000
const TOKEN_KEY = 'kds.staffToken'

const hashToken = new URLSearchParams(location.hash.slice(1)).get('token')
if (hashToken) {
  localStorage.setItem(TOKEN_KEY, hashToken)
  history.replaceState(null, '', location.pathname)
}
const token = localStorage.getItem(TOKEN_KEY)

const $ = (id) => document.getElementById(id)

// Waiting times run on the server's clock. Nobody sets the clock on a tablet
// screwed to a kitchen wall.
let clockOffsetMs = 0
let last = null

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  })
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY)
    showLocked()
    throw new Error('staff_only')
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** A staff action. A refusal comes back as {status:'rejected', reason}, to be shown. */
async function act(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY)
    showLocked()
    return { status: 'rejected', reason: 'staff_only' }
  }
  return res.json().catch(() => ({ status: 'rejected', reason: `http_${res.status}` }))
}

const REFUSALS = {
  not_credited: 'Ese pago se usó para comida: no se puede devolver desde aquí.',
  exceeds_payment: 'Es más de lo que se pagó.',
  exceeds_balance: 'La mesa ya no tiene ese saldo a favor.',
  reason_required: 'Escribí el motivo.',
  invalid_amount: 'El monto no es válido.',
  refund_not_pending: 'Esa devolución ya no está pendiente.',
  round_not_cancellable: 'La ronda ya no se puede cancelar: cambió de estado.',
  round_has_payments: 'Alguien ya pagó parte de esta ronda: no se puede cancelar.',
  round_not_stalled: 'La ronda ya no está trabada.',
  reservation_not_live: 'Esa reserva ya venció o ya se pagó.',
  dispatch_not_failed: 'Ese envío ya no está fallido.',
  tab_held: 'Alguien está pagando la cuenta en este momento.',
  nothing_to_write_off: 'No queda nada por asumir.',
  bill_not_requested: 'Primero pedí la cuenta de esa mesa.',
  draft_not_empty: 'La mesa tiene platos sin enviar en el carrito.',
}

const BLOCKERS = {
  bill_not_requested: 'falta pedir la cuenta',
  tab_unpaid: 'queda cuenta por pagar',
  round_in_collection: 'hay una ronda en cobro',
  balance_left: 'queda saldo a favor por devolver',
  refund_pending: 'hay una devolución pendiente',
  alert_open: 'tiene una alerta sin resolver',
}
const blockersText = (list) => list.map((b) => BLOCKERS[b] ?? b).join(', ')

function notice(text) {
  const n = $('notice')
  n.textContent = text
  n.hidden = false
  clearTimeout(notice.timer)
  notice.timer = setTimeout(() => (n.hidden = true), 5000)
}

/** Run an action; on refusal say why. Either way, show the fresh state. */
async function run(path, body) {
  const r = await act(path, body)
  if (r.status === 'rejected') {
    notice(r.reason === 'not_closable'
      ? `No se puede cerrar: ${blockersText(r.blockers)}.`
      : REFUSALS[r.reason] ?? `No se pudo (${r.reason}).`)
  }
  await refresh()
  return r
}

/** Ask before doing something that cannot be undone. Resolves true on "yes". */
function confirmAction({ title, body, yes }) {
  const d = $('confirm-dialog')
  $('confirm-title').textContent = title
  $('confirm-body').textContent = body
  $('confirm-yes').textContent = yes
  d.returnValue = ''
  d.showModal()
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true }))
}

function showLocked() {
  $('kds').hidden = true
  $('locked').hidden = false
}

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v)
  }
  for (const c of children) if (c != null && c !== false) node.append(c)
  return node
}

function waited(sinceIso) {
  const seconds = Math.max(0, Math.floor((Date.now() + clockOffsetMs - Date.parse(sinceIso)) / 1000))
  const m = Math.floor(seconds / 60)
  const s = String(seconds % 60).padStart(2, '0')
  return { seconds, text: `${m}:${s}` }
}

const money = (n) => `$${Number(n).toLocaleString('es-CO')}`

function describe(reason) {
  switch (reason.kind) {
    case 'money_not_placed':
      return `Pago que no se pudo aplicar: ${money(reason.amount)} quedó como saldo a favor de la mesa.`
    case 'delivery_failed':
      return `El pedido de la ronda ${reason.round_number} no llegó (${reason.channel}): ${reason.error ?? 'sin detalle'}.`
    case 'collection_stalled':
      return `El cobro de la ronda ${reason.round_number} quedó trabado.`
    default:
      return 'La mesa quedó marcada para revisión sin un motivo conocido.'
  }
}

function renderTickets(tickets) {
  $('order-count').textContent = tickets.length ? `${tickets.length} en cola` : ''
  $('no-orders').hidden = tickets.length > 0
  $('tickets').replaceChildren(...tickets.map((t) => {
    const w = waited(t.first_received_at)
    const lateness = w.seconds >= 20 * 60 ? ' very-late' : w.seconds >= 10 * 60 ? ' late' : ''
    return el('article', { class: `ticket${lateness}`, 'data-round': t.round_id },
      el('div', { class: 'ticket-head' },
        el('span', { class: 'ticket-table' }, t.table ?? '¿mesa?'),
        el('span', { class: 'ticket-wait', 'data-since': t.first_received_at }, w.text)),
      el('span', { class: 'ticket-round' }, `Ronda ${t.round_number}`),
      el('ul', { class: 'items' }, ...t.items.map((i) =>
        el('li', {},
          el('span', { class: 'qty' }, `${i.quantity}×`),
          el('span', {}, i.name, el('span', { class: 'who' }, i.ordered_by))))),
      el('button', {
        onclick: async (e) => {
          e.currentTarget.disabled = true
          await api(`/kds/api/tickets/${t.round_id}/done`, { method: 'POST' }).catch(() => {})
          refresh()
        },
      }, 'Listo'))
  }))
}

function renderAlerts(alerts) {
  const { tables, stalled_dispatches: stall } = alerts

  $('stall').hidden = !(stall.count > 0)
  if (stall.count > 0) {
    const minutes = Math.floor(stall.oldest_seconds / 60)
    $('stall').textContent =
      `Los pedidos no están llegando a la cocina: ${stall.count} esperando, ` +
      `el más antiguo hace ${minutes} min. Revisá que el worker esté corriendo.`
  }

  $('no-alerts').hidden = tables.length > 0
  $('alert-list').replaceChildren(...tables.map((a) =>
    el('li', { class: `alert${a.acknowledged_at ? ' acked' : ''}`, 'data-session': a.session_id },
      el('span', { class: 'alert-table' }, a.table),
      el('ul', {}, ...a.reasons.map((r) => el('li', { 'data-kind': r.kind }, describe(r), reasonActions(a, r)))),
      a.acknowledged_at
        ? el('span', { class: 'ack-note' },
            `Visto (${new Date(a.acknowledged_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}) — sigue sin resolver.`)
        : el('button', {
            class: 'secondary',
            onclick: async (e) => {
              e.currentTarget.disabled = true
              await api(`/kds/api/alerts/${a.session_id}/ack`, { method: 'POST' }).catch(() => {})
              refresh()
            },
          }, 'Visto'))))
}

const REFUND_STATE = { pending: 'pendiente', completed: 'completada' }

/** The buttons that resolve one reason. */
function reasonActions(table, reason) {
  if (reason.kind === 'money_not_placed') {
    const committed = reason.refunds.reduce((sum, f) => sum + Number(f.amount), 0)
    const left = Number(reason.amount) - committed
    return el('div', { class: 'actions' },
      ...reason.refunds.map((f) => el('div', { class: 'refund', 'data-refund': f.id },
        `Devolución ${money(f.amount)} — `,
        el('span', { class: `state${f.status === 'completed' ? ' done' : ''}` }, REFUND_STATE[f.status] ?? f.status),
        f.status === 'pending' && el('button', {
          onclick: () => run(`/kds/api/refunds/${f.id}/status`, { status: 'completed' }),
        }, 'Llegó'),
        f.status === 'pending' && el('button', {
          class: 'secondary',
          onclick: () => run(`/kds/api/refunds/${f.id}/status`, { status: 'rejected' }),
        }, 'No llegó'))),
      left > 0 && el('button', { onclick: () => openRefund(table, reason, left) }, 'Devolver'))
  }
  if (reason.kind === 'delivery_failed') {
    return el('div', { class: 'actions' },
      el('button', { onclick: () => run(`/kds/api/dispatches/${reason.dispatch_id}/retry`) }, 'Reintentar envío'))
  }
  if (reason.kind === 'collection_stalled') {
    return el('div', { class: 'actions' },
      el('button', { onclick: () => run(`/kds/api/rounds/${reason.round_id}/resume`) }, 'Reanudar cobro'),
      el('button', { class: 'danger', onclick: () => cancelRound(table.table, reason.round_number, reason.round_id) },
        'Cancelar ronda'))
  }
  return null
}

let refundTarget = null

function openRefund(table, reason, left) {
  const max = Math.min(left, Number(table.prepaid_balance))
  refundTarget = reason.contribution_id
  const form = $('refund-form')
  form.reset()
  form.amount.value = String(max)
  form.amount.max = String(max)
  $('refund-context').textContent =
    `${table.table}: ${money(reason.amount)} quedó como saldo a favor. ` +
    `Saldo disponible de la mesa: ${money(table.prepaid_balance)}.`
  $('refund-dialog').showModal()
}

$('refund-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.currentTarget
  $('refund-dialog').close()
  await run('/kds/api/refunds', {
    contribution_id: refundTarget,
    kind: form.kind.value,
    amount: Number(form.amount.value),
    reason: form.reason.value,
    external_reference: form.reference.value || null,
  })
})

for (const btn of document.querySelectorAll('dialog [data-close]')) {
  btn.addEventListener('click', () => btn.closest('dialog').close())
}
$('confirm-dialog').querySelector('form').addEventListener('submit', (e) => {
  e.preventDefault()
  $('confirm-dialog').close('yes')
})

async function cancelRound(table, roundNumber, roundId, holds = 0) {
  const ok = await confirmAction({
    title: `¿Cancelar la ronda ${roundNumber} de ${table}?`,
    body: 'No se envía nada a la cocina' +
      (holds ? ` y se liberan ${holds} reserva${holds === 1 ? '' : 's'}` : '') +
      '. Si alguien paga después, la plata queda como saldo a favor de la mesa.',
    yes: 'Sí, cancelar',
  })
  if (ok) await run(`/kds/api/rounds/${roundId}/cancel`)
}

const hhmm = (iso) => new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })

function renderCollections(collections) {
  $('no-collections').hidden = collections.length > 0
  $('collection-list').replaceChildren(...collections.map((c) => {
    const stalled = c.status === 'requires_staff_attention'
    return el('li', { class: `collection${stalled ? ' stalled' : ''}`, 'data-round': c.round_id },
      el('span', { class: 'collection-head' }, `${c.table} · Ronda ${c.round_number}`),
      el('span', {}, `Falta ${money(c.outstanding)} de ${money(c.total)}${stalled ? ' — trabada' : ''}`),
      c.reservations.length > 0 && el('ul', { class: 'holds' }, ...c.reservations.map((h) =>
        el('li', { 'data-reservation': h.id },
          el('span', {}, `${h.nickname} · ${money(h.amount)} · hasta ${hhmm(h.expires_at)}`),
          el('button', { class: 'secondary', onclick: () => run(`/kds/api/reservations/${h.id}/release`) }, 'Liberar')))),
      el('div', { class: 'actions' },
        stalled && el('button', { onclick: () => run(`/kds/api/rounds/${c.round_id}/resume`) }, 'Reanudar cobro'),
        el('button', {
          class: 'danger',
          onclick: () => cancelRound(c.table, c.round_number, c.round_id, c.reservations.length),
        }, 'Cancelar ronda')))
  }))
}

let writeOffTarget = null

function openWriteOff(t) {
  writeOffTarget = t.session_id
  $('writeoff-form').reset()
  $('writeoff-title').textContent = `¿Asumir la pérdida de ${t.table}?`
  $('writeoff-body').textContent =
    `Se da por perdida toda la cuenta pendiente: ${money(t.tab.total)}. ` +
    'No se le cobra a nadie y queda registrado con el motivo.'
  $('writeoff-dialog').showModal()
}

$('writeoff-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const reason = e.currentTarget.reason.value
  $('writeoff-dialog').close()
  await run(`/kds/api/sessions/${writeOffTarget}/write-off`, { reason })
})

function renderOpenTables(tables) {
  $('no-tables').hidden = tables.length > 0
  $('table-list').replaceChildren(...tables.map((t) => {
    const asked = Boolean(t.bill_requested_at)
    const owed = Number(t.tab.total)
    return el('li', { class: `collection${asked ? ' stalled' : ''}`, 'data-session': t.session_id },
      el('span', { class: 'collection-head' }, `${t.table}${asked ? ' · cuenta pedida' : ''}`),
      el('span', {}, owed > 0 ? `Cuenta pendiente: ${money(owed)}` : 'Sin cuenta pendiente'),
      owed > 0 && el('ul', { class: 'holds' }, ...t.tab.participants.map((p) =>
        el('li', {}, el('span', {}, `${p.nickname} · ${money(p.unpaid)}`)))),
      Number(t.prepaid_balance) > 0 && el('span', { class: 'muted' }, `Saldo a favor: ${money(t.prepaid_balance)}`),
      t.blockers.length > 0 && el('span', { class: 'muted blockers' }, `Para cerrar: ${blockersText(t.blockers)}.`),
      el('div', { class: 'actions' },
        !asked && el('button', { class: 'secondary', onclick: () => run(`/kds/api/sessions/${t.session_id}/bill`) },
          'Pedir la cuenta'),
        asked && owed > 0 && el('button', { class: 'danger', onclick: () => openWriteOff(t) }, 'Asumir pérdida'),
        el('button', { onclick: () => run(`/kds/api/sessions/${t.session_id}/close`) }, 'Cerrar mesa')))
  }))
}

let inFlight = false
async function refresh() {
  if (inFlight || !token) return
  inFlight = true
  try {
    const state = await api('/kds/api/state')
    clockOffsetMs = Date.parse(state.now) - Date.now()
    last = state
    $('offline').hidden = true
    renderTickets(state.tickets)
    renderAlerts(state.alerts)
    renderCollections(state.collections)
    renderOpenTables(state.open_tables)
  } catch (err) {
    if (err.message !== 'staff_only') $('offline').hidden = false
  } finally {
    inFlight = false
  }
}

// Timers tick every second without waiting for the next poll.
setInterval(() => {
  if (!last) return
  for (const node of document.querySelectorAll('.ticket-wait')) {
    node.textContent = waited(node.dataset.since).text
  }
}, 1000)

if (!token) {
  showLocked()
} else {
  $('kds').hidden = false
  refresh()
  setInterval(refresh, POLL_MS)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh())
  window.addEventListener('focus', refresh)
}
