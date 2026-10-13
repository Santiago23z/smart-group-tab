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
async function act(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
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

// Everything is redrawn every poll. A card animates in only when it arrives
// while the screen is open; what is already there on load (possibly hundreds
// of tables) appears at once, and nothing that was drawn before moves again.
const seen = new Set()
let primed = false
const fresh = (key) => (seen.has(key) ? '' : (seen.add(key), primed ? ' enter' : ''))

// Tickets marked done, fading out until the server stops listing them. A poll
// already in flight may still list one; it keeps fading instead of popping back.
const leaving = new Set()

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

// Whether the round is paid, as a word: the cooks never see an amount.
const PAYMENT = { unpaid: 'sin pagar', paid: 'pagado · por llevar', written_off: 'pérdida asumida' }

function renderTickets(tickets) {
  $('order-count').textContent = tickets.length ? `${tickets.length} en cola` : ''
  $('no-orders').hidden = tickets.length > 0
  for (const id of leaving) if (!tickets.some((t) => t.round_id === id)) leaving.delete(id)
  $('tickets').replaceChildren(...tickets.map((t) => {
    const w = waited(t.first_received_at)
    const lateness = w.seconds >= 20 * 60 ? ' very-late' : w.seconds >= 10 * 60 ? ' late' : ''
    const motion = leaving.has(t.round_id) ? ' leaving' : fresh(`t:${t.round_id}`)
    return el('article', { class: `ticket${lateness}${motion}`, 'data-round': t.round_id },
      el('div', { class: 'ticket-head' },
        el('span', { class: 'ticket-table' }, t.table ?? '¿mesa?'),
        el('span', { class: 'ticket-wait', 'data-since': t.first_received_at }, w.text)),
      el('span', { class: 'ticket-round' }, `Ronda ${t.round_number}`,
        el('span', { class: `pay ${t.payment}` }, PAYMENT[t.payment] ?? t.payment)),
      el('ul', { class: 'items' }, ...t.items.map((i) =>
        el('li', {},
          el('span', { class: 'qty' }, `${i.quantity}×`),
          el('span', {}, i.name, el('span', { class: 'who' }, i.ordered_by))))),
      el('button', {
        onclick: async (e) => {
          e.currentTarget.disabled = true
          e.currentTarget.closest('.ticket').classList.add('leaving')
          leaving.add(t.round_id)
          await api(`/kds/api/tickets/${t.round_id}/done`, { method: 'POST' }).catch(() => leaving.delete(t.round_id))
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
    el('li', { class: `alert${a.acknowledged_at ? ' acked' : ''}${fresh(`a:${a.session_id}`)}`, 'data-session': a.session_id },
      el('span', { class: 'alert-table' }, a.table),
      el('ul', {}, ...a.reasons.map((r) => el('li', { 'data-kind': r.kind }, describe(r), reasonActions(a, r)))),
      a.acknowledged_at
        ? el('span', { class: 'ack-note' },
            `Visto (${new Date(a.acknowledged_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}) — sigue sin resolver.`)
        : el('button', {
            class: 'text',
            onclick: async (e) => {
              e.currentTarget.disabled = true
              await api(`/kds/api/alerts/${a.session_id}/ack`, { method: 'POST' }).catch(() => {})
              refresh()
            },
          }, 'Visto'))))
  $('alert-count').textContent = tables.length ? String(tables.length) : ''
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
  $('collection-count').textContent = collections.length ? String(collections.length) : ''
  $('collection-list').replaceChildren(...collections.map((c) => {
    const stalled = c.status === 'requires_staff_attention'
    return el('li', { class: `collection${stalled ? ' stalled' : ''}${fresh(`c:${c.round_id}`)}`, 'data-round': c.round_id },
      el('span', { class: 'collection-head' }, `${c.table} · Ronda ${c.round_number}`),
      el('span', {}, `Falta ${money(c.outstanding)} de ${money(c.total)}${stalled ? ' — trabada' : ''}`),
      c.reservations.length > 0 && el('ul', { class: 'holds' }, ...c.reservations.map((h) =>
        el('li', { 'data-reservation': h.id },
          el('span', {}, `${h.nickname} · ${money(h.amount)} · hasta ${hhmm(h.expires_at)}`),
          el('button', { class: 'secondary', onclick: () => run(`/kds/api/reservations/${h.id}/release`) }, 'Liberar')))),
      el('div', { class: 'actions' },
        !stalled && Number(c.unclaimed) > 0 && el('button', {
          onclick: () => openCash({
            scope: 'round', targetId: c.round_id, table: `${c.table} · Ronda ${c.round_number}`,
            choices: [
              ...c.parts.map((p) => ({ participantId: p.participant_id, label: p.nickname, amount: Number(p.free) })),
              { participantId: null, label: 'Todo lo que falta', amount: Number(c.unclaimed) },
            ],
          }),
        }, 'Cobrar en caja'),
        stalled && el('button', { onclick: () => run(`/kds/api/rounds/${c.round_id}/resume`) }, 'Reanudar cobro'),
        el('button', {
          class: 'danger',
          onclick: () => cancelRound(c.table, c.round_number, c.round_id, c.reservations.length),
        }, 'Cancelar ronda')))
  }))
}

// ---------------------------------------------------------------------------
// Cobrar en caja
// ---------------------------------------------------------------------------
const METHOD = { cash: 'efectivo', card_terminal: 'datáfono' }
let cashTarget = null

/**
 * "Quieren pagar": a diner asked from their phone. The amount is what that
 * part still owes; whatever is held is someone paying it in Wompi right now,
 * which the cash dialog would not take, so it is not offered.
 */
function renderCashRequests(requests) {
  const shown = requests.length > 0
  $('cash-request-header').hidden = !shown
  $('cash-request-list').hidden = !shown
  $('alert-header').classList.toggle('sub', shown)
  $('cash-request-count').textContent = shown ? String(requests.length) : ''
  $('cash-request-list').replaceChildren(...requests.map((r) => {
    const who = r.participant_id ? r.nickname : `${r.nickname}, por lo que falta`
    const free = Number(r.amount) - Number(r.held)
    const target = r.target_scope === 'round' ? 'la ronda' : 'la cuenta'
    return el('li', { class: `collection call${fresh(`q:${r.id}`)}`, 'data-cash-request': r.id },
      el('span', { class: 'collection-head' }, `${r.table} · ${who}`),
      el('span', {}, `${money(r.amount)} de ${target}, en ${METHOD[r.method]} · hace `,
        el('span', { class: 'ticket-wait', 'data-since': r.created_at }, waited(r.created_at).text)),
      Number(r.held) > 0 && el('span', { class: 'muted' }, `${money(r.held)} se está pagando en Wompi ahora.`),
      el('div', { class: 'actions' },
        free > 0 && el('button', {
          onclick: () => openCash({
            scope: r.target_scope, targetId: r.target_id, table: r.table, method: r.method,
            choices: [{ participantId: r.participant_id, label: r.participant_id ? r.nickname : 'Todo lo que falta', amount: free }],
          }),
        }, 'Cobrar en caja'),
        el('button', { class: 'secondary', onclick: () => run(`/kds/api/cash-requests/${r.id}/dismiss`) }, 'Descartar')))
  }))
}

/**
 * choices: [{ participantId (null = the rest), label, amount }]. The amount is
 * shown, never typed: the database charges exactly what the part adds up to.
 */
function openCash({ scope, targetId, table, choices, method = 'cash' }) {
  cashTarget = { scope, targetId, table, choices }
  const form = $('cash-form')
  form.reset()
  form.method.value = method
  $('cash-title').textContent = `Cobrar en caja · ${table}`
  $('cash-parts').replaceChildren(...choices.map((c, i) =>
    el('label', {},
      el('input', { type: 'radio', name: 'part', value: String(i), ...(i === choices.length - 1 ? { checked: '' } : {}) }),
      el('span', {}, c.label),
      el('span', { class: 'amt' }, money(c.amount)))))
  $('cash-dialog').showModal()
}

$('cash-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.currentTarget
  const choice = cashTarget.choices[Number(form.part.value)]
  const tip = Number(form.tip.value || 0)
  const method = form.method.value
  $('cash-dialog').close()

  const ok = await confirmAction({
    title: `¿Registrar ${money(choice.amount + tip)} en ${METHOD[method]}?`,
    body: `${cashTarget.table} · ${choice.label}${tip ? ` (incluye ${money(tip)} de propina)` : ''}. ` +
      'Queda como pagado y no se puede deshacer.',
    yes: 'Sí, registrar',
  })
  if (!ok) return
  await run('/kds/api/manual-payments', {
    scope: cashTarget.scope,
    target_id: cashTarget.targetId,
    participant_id: choice.participantId,
    method,
    reference: form.reference.value || null,
    tip,
  })
})

// ---------------------------------------------------------------------------
// Carta: agotados, y subir la hoja de cálculo con vista previa
// ---------------------------------------------------------------------------
const VENUE_KEY = 'kds.venue'
let venueId = localStorage.getItem(VENUE_KEY)
let pendingCsv = null

async function getJson(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } })
  return res.json()
}

let venueList = []

async function openMenu() {
  const { venues } = await getJson('/kds/api/venues')
  venueList = venues
  if (!venues.some((v) => v.id === venueId)) venueId = venues[0]?.id ?? null
  // One venue: nothing to choose. Several: say which one, every time.
  const select = $('menu-venue')
  select.hidden = venues.length < 2
  select.replaceChildren(...venues.map((v) => el('option', { value: v.id, ...(v.id === venueId ? { selected: '' } : {}) }, v.name)))
  $('menu-preview').hidden = true
  $('menu-dialog').showModal()
  renderMode()
  await renderMenu()
}

// ---------------------------------------------------------------------------
// Cómo se cobra. Hybrid is shown only as a venue's current mode: nothing lets a
// table leave a prepaid balance yet, so it is not offered as a choice.
// ---------------------------------------------------------------------------
const MODES = {
  pay_before_order: ['Pagar antes', 'La cocina recibe cada ronda cuando está pagada completa.'],
  open_tab: ['Cuenta abierta', 'La ronda va directo a la cocina; se paga al final, al pedir la cuenta.'],
}

function renderMode() {
  const venue = venueList.find((v) => v.id === venueId)
  $('mode-box').hidden = !venue
  if (!venue) return
  // replaceChildren, unlike el(), would print a false as text.
  $('mode-choices').replaceChildren(...[
    ...Object.entries(MODES).map(([mode, [label, line]]) => el('button', {
      type: 'button', class: `mode${venue.mode === mode ? ' current' : ''}`, 'data-mode': mode,
      'aria-pressed': String(venue.mode === mode),
      onclick: () => venue.mode !== mode && setMode(venue, mode),
    }, el('strong', {}, label), el('span', {}, line))),
    venue.mode === 'hybrid' && el('button', { type: 'button', class: 'mode current', disabled: '', 'aria-pressed': 'true' },
      el('strong', {}, 'Híbrido'), el('span', {}, 'La primera ronda se paga antes; las siguientes, con el saldo de la mesa.')),
  ].filter(Boolean))
}

async function setMode(venue, mode) {
  const ok = await confirmAction({
    title: `¿Cobrar con «${MODES[mode][0]}» en ${venue.name}?`,
    body: `${MODES[mode][1]} Aplica a las mesas que se abran desde ahora; las que ya están sentadas siguen como empezaron.`,
    yes: 'Sí, cambiar',
  })
  if (!ok) return
  const r = await act(`/kds/api/venues/${venue.id}/service-mode`, { mode })
  if (r.status === 'updated' || r.status === 'unchanged') {
    venue.mode = mode
    notice(`Listo: las mesas nuevas se cobran con «${MODES[mode][0]}».`)
  } else {
    notice(r.reason === 'invalid_mode' ? 'Ese modo no se puede elegir desde aquí.' : `No se pudo (${r.reason}).`)
  }
  renderMode()
}

$('menu-venue').addEventListener('change', async (e) => {
  venueId = e.target.value
  localStorage.setItem(VENUE_KEY, venueId)
  $('menu-preview').hidden = true
  renderMode()
  await renderMenu()
})

async function renderMenu() {
  if (!venueId) return $('menu-list').replaceChildren(el('p', { class: 'muted' }, 'No hay restaurantes cargados.'))
  localStorage.setItem(VENUE_KEY, venueId)
  const { products } = await getJson(`/kds/api/venues/${venueId}/menu`)
  const onMenu = products.filter((p) => p.is_available)
  const groups = {}
  for (const p of onMenu) (groups[p.category ?? 'Carta'] ??= []).push(p)
  $('menu-list').replaceChildren(...Object.entries(groups).flatMap(([cat, items]) => [
    el('p', { class: 'menu-cat' }, cat),
    ...items.map((p) => el('div', { class: `dish${p.sold_out ? ' out' : ''}`, 'data-product': p.id },
      p.photo
        ? el('img', { class: 'thumb', src: `/kds/photos/${p.id}/${p.photo}/thumb.jpg`, alt: '' })
        : el('span', { class: 'thumb empty' }, 'sin foto'),
      el('span', { class: 'name' }, p.name, p.description && el('span', { class: 'desc' }, p.description)),
      el('div', { class: 'photo-actions' },
        el('button', { class: 'secondary', onclick: () => pickPhoto(p.id) }, p.photo ? 'Cambiar foto' : 'Foto'),
        p.photo && el('button', {
          class: 'text',
          onclick: async () => {
            await fetch(`/kds/api/venues/${venueId}/products/${p.id}/photo`,
              { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
            await renderMenu()
          },
        }, 'Quitar')),
      el('span', { class: 'price' }, money(p.unit_price)),
      el('button', {
        class: p.sold_out ? '' : 'secondary',
        onclick: async () => {
          await run(`/kds/api/venues/${venueId}/products/${p.id}/sold-out`, { sold_out: !p.sold_out })
          await renderMenu()
        },
      }, p.sold_out ? 'Volver a ofrecer' : 'Marcar agotado'))),
  ]))
}

$('menu-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  pendingCsv = await file.text()
  const r = await act(`/kds/api/venues/${venueId}/menu`, { csv: pendingCsv })
  const box = $('menu-preview')
  box.hidden = false
  if (r.errors) {
    pendingCsv = null
    box.className = 'bad'
    box.replaceChildren(
      el('strong', {}, 'La carta tiene errores. No se cambió nada.'),
      el('ul', {}, ...r.errors.map((m) => el('li', {}, m))))
    return
  }
  box.className = ''
  const list = (title, names) => names.length > 0 && el('div', {}, el('strong', {}, `${title} (${names.length})`),
    el('ul', {}, ...names.map((n) => el('li', {}, n))))
  box.replaceChildren(
    el('strong', {}, `Vista previa: ${r.added.length} nuevos, ${r.updated.length} actualizados, ${r.hidden.length} se ocultan.`),
    list('Nuevos', r.added), list('Se ocultan', r.hidden),
    el('div', { class: 'actions' },
      el('button', { class: 'secondary', onclick: () => { pendingCsv = null; box.hidden = true } }, 'Cancelar'),
      el('button', {
        onclick: async () => {
          const applied = await act(`/kds/api/venues/${venueId}/menu`, { csv: pendingCsv, apply: true })
          pendingCsv = null
          box.hidden = true
          notice(applied.status === 'applied'
            ? `Carta aplicada: ${applied.added.length} nuevos, ${applied.updated.length} actualizados, ${applied.hidden.length} ocultos.`
            : 'No se pudo aplicar la carta.')
          await renderMenu()
        },
      }, 'Aplicar')))
})

$('open-menu').addEventListener('click', openMenu)

// ---------------------------------------------------------------------------
// Recibido hoy: the total in the top bar, the breakdown in a dialog.
// ---------------------------------------------------------------------------
function renderTakings(t) {
  $('takings-total').textContent = money(t.total)
  const [y, m, d] = String(t.day).split('-')
  $('takings-day').textContent = `${d}/${m}/${y}, desde las 00:00 (hora de Colombia).`
  const line = (label, value, cls = '') => [el('dt', { class: cls }, label), el('dd', { class: cls }, money(value))]
  $('takings-lines').replaceChildren(
    ...line('Wompi', t.wompi), ...line('Efectivo', t.cash), ...line('Datáfono', t.card_terminal),
    ...line('Total', t.total, 'total'),
    ...line('De eso, propinas', t.tips, 'note'),
    ...line('Devuelto hoy (aparte)', t.refunded, 'note'))
}
$('open-takings').addEventListener('click', () => $('takings-dialog').showModal())

// ---------------------------------------------------------------------------
// Dish photos: shrunk here, on the tablet, before anything is sent. A 4 MB
// phone photo becomes a ~20 KB thumbnail and a ~150 KB larger version, so the
// server never decodes images and diners on bad wifi download almost nothing.
// ---------------------------------------------------------------------------
let photoTarget = null

function pickPhoto(productId) {
  photoTarget = productId
  $('photo-file').click()
}

/** Draws the image into a canvas no larger than `max` (square-cropped if asked) → JPEG base64. */
async function shrink(bitmap, max, square) {
  const side = Math.min(bitmap.width, bitmap.height)
  const [sx, sy, sw, sh] = square
    ? [(bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side]
    : [0, 0, bitmap.width, bitmap.height]
  const scale = Math.min(1, max / Math.max(sw, sh))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.readAsDataURL(blob)
  })
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}

$('photo-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file || !photoTarget) return
  const row = document.querySelector(`.dish[data-product="${photoTarget}"]`)
  const button = row?.querySelector('.photo-actions button')
  if (button) { button.disabled = true; button.textContent = 'Procesando…' }

  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    notice('Esa imagen no se puede abrir aquí. Usá una foto JPG o PNG.')
    return renderMenu()
  }
  const [thumb, large] = [await shrink(bitmap, 240, true), await shrink(bitmap, 800, false)]
  const r = await act(`/kds/api/venues/${venueId}/products/${photoTarget}/photo`, { thumb, large }, 'PUT')
  if (r.status !== 'updated') notice('No se pudo guardar la foto.')
  photoTarget = null
  await renderMenu()
})

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
  $('table-count').textContent = tables.length ? String(tables.length) : ''
  // Tables with something going on first; quiet ones last, as one line each.
  const quiet = (t) => !t.bill_requested_at && Number(t.tab.total) === 0 && Number(t.prepaid_balance) === 0
  const sorted = [...tables].sort((a, b) => quiet(a) - quiet(b))
  $('table-list').replaceChildren(...sorted.map((t) => {
    const asked = Boolean(t.bill_requested_at)
    const owed = Number(t.tab.total)
    if (quiet(t)) {
      return el('li', { class: `collection idle${fresh(`o:${t.session_id}`)}`, 'data-session': t.session_id },
        el('span', { class: 'collection-head' }, t.table),
        el('span', { class: 'muted' }, 'sin cuenta'),
        el('div', { class: 'actions' },
          el('button', { class: 'secondary', onclick: () => run(`/kds/api/sessions/${t.session_id}/bill`) }, 'Pedir la cuenta')))
    }
    return el('li', { class: `collection${asked ? ' stalled' : ''}${fresh(`o:${t.session_id}`)}`, 'data-session': t.session_id },
      el('span', { class: 'collection-head' }, `${t.table}${asked ? ' · cuenta pedida' : ''}`),
      el('span', {}, owed > 0 ? `Cuenta pendiente: ${money(owed)}` : 'Sin cuenta pendiente'),
      owed > 0 && el('ul', { class: 'holds' }, ...t.tab.participants.map((p) =>
        el('li', {}, el('span', {}, `${p.nickname} · ${money(p.unpaid)}`)))),
      Number(t.prepaid_balance) > 0 && el('span', { class: 'muted' }, `Saldo a favor: ${money(t.prepaid_balance)}`),
      t.blockers.length > 0 && el('span', { class: 'muted blockers' }, `Para cerrar: ${blockersText(t.blockers)}.`),
      el('div', { class: 'actions' },
        !asked && el('button', { class: 'secondary', onclick: () => run(`/kds/api/sessions/${t.session_id}/bill`) },
          'Pedir la cuenta'),
        asked && owed - Number(t.tab.held) > 0 && el('button', {
          onclick: () => openCash({
            scope: 'tab', targetId: t.session_id, table: t.table,
            choices: [
              ...t.tab.participants
                .filter((p) => Number(p.unpaid) - Number(p.held) > 0)
                .map((p) => ({ participantId: p.participant_id, label: p.nickname, amount: Number(p.unpaid) - Number(p.held) })),
              { participantId: null, label: 'Todo lo que falta', amount: owed - Number(t.tab.held) },
            ],
          }),
        }, 'Cobrar en caja'),
        asked && owed > 0 && el('button', { class: 'danger', onclick: () => openWriteOff(t) }, 'Asumir pérdida'),
        // Amber only when it will work; otherwise it stays available (and says
        // why it cannot close) without inviting the tap.
        el('button', {
          class: t.blockers.length ? 'secondary' : '',
          onclick: () => run(`/kds/api/sessions/${t.session_id}/close`),
        }, 'Cerrar mesa')))
  }))
}

let inFlight = false
async function refresh() {
  if (inFlight || !token) return
  inFlight = true
  try {
    const state = await api('/kds/api/state')
    clockOffsetMs = Date.parse(state.now) - Date.now()
    $('clock').textContent = new Date(Date.now() + clockOffsetMs)
      .toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
    last = state
    $('offline').hidden = true
    renderTickets(state.tickets)
    renderCashRequests(state.cash_requests)
    renderAlerts(state.alerts)
    renderCollections(state.collections)
    renderOpenTables(state.open_tables)
    renderTakings(state.takings)
    primed = true
  } catch (err) {
    if (err.message !== 'staff_only') $('offline').hidden = false
  } finally {
    inFlight = false
  }
}

// Timers tick every second without waiting for the next poll.
setInterval(() => {
  $('clock').textContent = new Date(Date.now() + clockOffsetMs)
    .toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
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
