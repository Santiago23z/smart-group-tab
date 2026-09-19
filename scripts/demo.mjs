#!/usr/bin/env node
// Smart Group Tab — a narrated run through a whole table.
//
// Drives the real RPCs against the real database, printing what happens at each
// step. Nothing is stubbed: the same functions the tests exercise, in the order a
// Friday night actually goes.
//
//   DATABASE_URL=... node scripts/demo.mjs

import pg from 'pg'
import { createPaymentIntent } from '../src/wompi/intent.mjs'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

const CHECKOUT = {
  publicKey: process.env.WOMPI_PUBLIC_KEY ?? 'pub_test_demo',
  integritySecret: process.env.WOMPI_INTEGRITY_SECRET ?? 'demo_integrity_secret',
  redirectUrl: 'https://tab.example.com/gracias',
}

const pool = new pg.Pool({ connectionString, max: 16 })

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const cyan = (s) => `\x1b[36m${s}\x1b[0m`
const money = (n) => `$${Number(n).toLocaleString('es-CO')}`

let step = 0
function scene(title) {
  step++
  console.log(`\n${bold(`${step}. ${title}`)}`)
}
const say = (s) => console.log(`   ${s}`)

const rpc = async (sql, params) => (await pool.query(sql, params)).rows[0].r

/** Prints who owes what right now, straight from the ledger. */
async function showTable(roundId) {
  const { rows } = await pool.query(
    `select p.nickname,
            sum(s.owed_amount)                                    as owes,
            sum(s.owed_amount) filter (where is_share_settled(s.id)) as paid
       from active_shares($1) s
       join participants p on p.id = s.participant_id
      group by p.nickname order by p.nickname`,
    [roundId]
  )
  for (const r of rows) {
    const paid = Number(r.paid ?? 0)
    const owes = Number(r.owes)
    const mark = paid >= owes ? green('pagado') : yellow(`debe ${money(owes - paid)}`)
    say(`${r.nickname.padEnd(12)} ${money(owes).padStart(10)}   ${mark}`)
  }
  const { rows: t } = await pool.query(
    `select round_total($1) as total, round_outstanding($1) as left`,
    [roundId]
  )
  say(dim(`total ${money(t[0].total)} · sin cubrir ${money(t[0].left)}`))
}

// ---------------------------------------------------------------------------
console.log(bold('\n  Smart Group Tab — una mesa de principio a fin\n'))
console.log(dim('  Todo lo que sigue son las RPCs reales contra la base real.'))

// ---------------------------------------------------------------------------
scene('El local abre la mesa')
const venue = (await pool.query(
  `insert into venues (name, default_service_mode, reservation_ttl)
   values ('Gastrobar Demo', 'pay_before_order', interval '5 minutes') returning id`
)).rows[0]
const qr = `qr-demo-${Math.random().toString(36).slice(2, 8)}`
await pool.query(`insert into tables (venue_id, label, qr_token) values ($1, 'Mesa 12', $2)`, [
  venue.id,
  qr,
])
const menu = {}
for (const [name, price] of [['Picada', 32000], ['Cerveza', 12000], ['Michelada', 15000]]) {
  menu[name] = (await pool.query(
    `insert into products (venue_id, name, unit_price, tax_rate) values ($1,$2,$3,0.08) returning id`,
    [venue.id, name, price]
  )).rows[0].id
}
say(`Mesa 12, modalidad ${cyan('pay_before_order')} — la cocina no ve nada hasta el 100%`)
say(dim(`QR: ${qr}`))

// ---------------------------------------------------------------------------
scene('Tres personas escanean el QR a la vez')
const [santi, cache, juan] = await Promise.all(
  ['Santi', 'Cachetona', 'Juan'].map((n) =>
    rpc(`select open_or_join_session($1,$2) as r`, [qr, n])
  )
)
const sessionId = santi.session_id
const roundId = santi.round_id
const sameTab = new Set([santi, cache, juan].map((p) => p.session_id)).size === 1
say(sameTab ? green('Una sola cuenta para los tres') : '\x1b[31mSe abrieron cuentas separadas\x1b[0m')
say(dim('simultáneo: el candado sobre la mesa decide quién la crea'))

// ---------------------------------------------------------------------------
scene('Piden: una picada para compartir y una bebida cada uno')
const picada = await rpc(`select add_cart_item($1,$2,$3,1,$4::uuid[]) as r`, [
  sessionId,
  santi.participant_id,
  menu.Picada,
  [santi.participant_id, cache.participant_id, juan.participant_id],
])
say(`Picada ${money(picada.line_total)} entre tres → ${picada.shares.map((s) => money(s.owed_amount)).join(' + ')}`)
say(dim(`suma exacta: ${money(picada.shares.reduce((a, s) => a + s.owed_amount, 0))} — el resto no se pierde`))

await rpc(`select add_cart_item($1,$2,$3,1,null) as r`, [sessionId, santi.participant_id, menu.Cerveza])
await rpc(`select add_cart_item($1,$2,$3,1,null) as r`, [sessionId, cache.participant_id, menu.Michelada])
await rpc(`select add_cart_item($1,$2,$3,1,null) as r`, [sessionId, juan.participant_id, menu.Cerveza])
say('Cada quien su bebida')

// ---------------------------------------------------------------------------
scene('Cierran la ronda y pasa a cobro')
const closed = await rpc(`select close_round($1,'as_ordered') as r`, [sessionId])
say(`Total ${bold(money(closed.round_total))} · estado ${cyan(closed.status)}`)
await showTable(roundId)

// ---------------------------------------------------------------------------
scene('Santi y Cachetona intentan pagar el saldo completo al mismo tiempo')
const race = await Promise.all(
  [santi, cache].map((p, i) =>
    rpc(`select reserve_contribution($1,$2,'remaining','demo-race-${Math.random()}',null,null,0) as r`, [
      roundId,
      p.participant_id,
    ])
  )
)
const winner = race.findIndex((r) => r.status === 'reserved')
say(`${green('gana')}    ${[santi, cache][winner] === santi ? 'Santi' : 'Cachetona'} → reserva ${money(race[winner].order_amount)}`)
const loser = race[1 - winner]
say(`${yellow('pierde')}  ${loser.reason} — el otro ya tomó todo el saldo`)
say(dim('el perdedor recibe el estado fresco de la mesa, no un error que no pueda accionar'))

// Deshacemos la carrera para seguir con el caso interesante.
await pool.query(
  `update contribution_reservations set status='cancelled', settled_at=now() where round_id=$1`,
  [roundId]
)

// ---------------------------------------------------------------------------
scene('Cada quien paga lo suyo — Juan deja propina')
const claims = {}
for (const [name, p, tip] of [['Santi', santi, 0], ['Cachetona', cache, 0], ['Juan', juan, 5000]]) {
  const c = await rpc(
    `select reserve_contribution($1,$2,'my_items',$3,null,null,$4::bigint) as r`,
    [roundId, p.participant_id, `demo-${name}-${Math.random()}`, tip]
  )
  claims[name] = c
  say(`${name.padEnd(12)} reserva ${money(c.order_amount)}${tip ? dim(` + ${money(tip)} de propina`) : ''}`)
}

// ---------------------------------------------------------------------------
scene('El sistema le pide el cobro a Wompi')
for (const [name, c] of Object.entries(claims)) {
  const intent = await createPaymentIntent(pool, {
    reservationId: c.reservation_id,
    config: CHECKOUT,
  })
  const ref = new URL(intent.checkout_url).searchParams.get('reference')
  say(`${name.padEnd(12)} ${money(intent.amount_in_cents / 100)} → ${dim(ref)}`)
  claims[name].intent = intent
}
say(dim('la referencia es la de la reserva, y el link muere cuando muere la retención'))

// ---------------------------------------------------------------------------
scene('Wompi confirma los pagos')
for (const [name, c] of Object.entries(claims)) {
  const r = await rpc(`select confirm_webhook('wompi',$1,$2,'approved',$3::bigint,'{}'::jsonb,true) as r`, [
    `demo-${name}-${Math.random()}`,
    c.psp_reference,
    c.intent.amount_in_cents / 100,
  ])
  const fired = r.dispatched ? green('  ← este completa la ronda') : ''
  say(`${name.padEnd(12)} ${r.status}${fired}`)
}

// ---------------------------------------------------------------------------
scene('La comanda sale a cocina')
const { rows: state } = await pool.query(
  `select r.status::text as status,
          (select count(*) from dispatches d where d.round_id = r.id) as despachos,
          (select coalesce(sum(c.tip_amount),0) from contributions c where c.round_id = r.id) as propinas
     from rounds r where r.id = $1`,
  [roundId]
)
say(`Ronda ${cyan(state[0].status)} · ${state[0].despachos} despachos (KDS + impresora)`)
say(`Propina recaudada: ${money(state[0].propinas)} ${dim('— nunca contó para liberar la comida')}`)
await showTable(roundId)

// ---------------------------------------------------------------------------
scene('Siguen pidiendo mientras tanto')
const later = await rpc(`select add_cart_item($1,$2,$3,1,null) as r`, [
  sessionId,
  juan.participant_id,
  menu.Cerveza,
])
say(`Otra cerveza → ronda ${bold(later.round_number)} ${dim('(la ronda 1 está congelada, no se toca)')}`)

console.log(green('\n  La mesa comió. Nadie pagó de más. La cocina recibió una sola comanda.\n'))
await pool.end()
