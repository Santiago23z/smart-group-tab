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
  for (const c of children) if (c != null) node.append(c)
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
      el('ul', {}, ...a.reasons.map((r) => el('li', {}, describe(r)))),
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
