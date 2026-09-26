#!/usr/bin/env node
// Smart Group Tab — the app a diner actually touches.
//
// A thin HTTP layer over the RPCs that already exist, plus the static page that
// calls it. There is no business logic here on purpose: every decision about
// money still happens inside Postgres, under the round lock, exactly as the tests
// exercise it.
//
// Identity is passed through as `app.participant_id`, which means the caller
// checks added during the code review are genuinely exercised by this app rather
// than skipped the way a trusted service-role connection would skip them.
//
//   DATABASE_URL=... npm run web

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import pg from 'pg'
import QRCode from 'qrcode'
import { createPaymentIntent } from '../wompi/intent.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const publicDir = join(root, 'public')

const port = Number(process.env.PORT ?? 8788)
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

// Without real Wompi keys the app still needs a way to let you walk the whole
// flow. This stands in for "the diner paid" and is refused unless explicitly on.
const allowSimulatedPayments = process.env.ALLOW_SIMULATED_PAYMENTS !== 'false'

const checkoutConfig = {
  publicKey: process.env.WOMPI_PUBLIC_KEY ?? null,
  integritySecret: process.env.WOMPI_INTEGRITY_SECRET ?? null,
  checkoutBaseUrl: process.env.WOMPI_CHECKOUT_URL ?? 'https://checkout.wompi.co/p/',
  redirectUrl: process.env.WOMPI_REDIRECT_URL ?? null,
}

const pool = new pg.Pool({ connectionString, max: 12 })

/**
 * Runs a statement with the caller's participant id in scope, so SECURITY
 * DEFINER functions can check it. `set_config(..., true)` is transaction-local,
 * so nothing leaks onto the next request that borrows this connection.
 */
async function asParticipant(participantId, fn) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    if (participantId) {
      await client.query(`select set_config('app.participant_id', $1, true)`, [participantId])
    }
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const rpc = (client, sql, params) => client.query(sql, params).then((r) => r.rows[0].r)

// ---------------------------------------------------------------------------
// Everything the screen needs, in one round trip. The page polls this; with
// Supabase in place it would be a Realtime subscription over the same shape.
// ---------------------------------------------------------------------------
async function tableState(sessionId, participantId) {
  const { rows } = await pool.query(
    `select jsonb_build_object(
       'session', jsonb_build_object(
         'id', se.id, 'status', se.status, 'service_mode', se.service_mode,
         'prepaid_balance', se.prepaid_balance),
       'venue', jsonb_build_object('name', v.name, 'currency', v.currency),
       'table', jsonb_build_object('label', t.label),
       'participants', (
         select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nickname', p.nickname)
                         order by p.joined_at), '[]'::jsonb)
           from participants p where p.session_id = se.id),
       'menu', (
         select coalesce(jsonb_agg(jsonb_build_object(
                  'id', pr.id, 'name', pr.name, 'category', pr.category,
                  'unit_price', pr.unit_price, 'tax_rate', pr.tax_rate)
                 order by pr.category nulls last, pr.name), '[]'::jsonb)
           from products pr where pr.venue_id = se.venue_id and pr.is_available),
       'rounds', (
         select coalesce(jsonb_agg(jsonb_build_object(
                  'id', r.id, 'number', r.round_number, 'status', r.status,
                  'total', round_total(r.id), 'outstanding', round_outstanding(r.id),
                  'items', (
                    select coalesce(jsonb_agg(jsonb_build_object(
                             'id', ci.id, 'name', pr.name, 'quantity', ci.quantity,
                             'line_total', ci.line_total,
                             'added_by', ci.added_by_participant_id,
                             'shares', (
                               select coalesce(jsonb_agg(jsonb_build_object(
                                        'id', s.id, 'participant_id', s.participant_id,
                                        'owed_amount', s.owed_amount,
                                        'held', is_share_held(s.id),
                                        'settled', is_share_settled(s.id))
                                       order by s.id), '[]'::jsonb)
                                 from cart_item_shares s where s.cart_item_id = ci.id))
                           order by ci.created_at), '[]'::jsonb)
                      from cart_items ci
                      join products pr on pr.id = ci.product_id
                     where ci.round_id = r.id and ci.status = 'active'))
                 order by r.round_number), '[]'::jsonb)
           from rounds r where r.session_id = se.id and r.status <> 'cancelled'),
       'my_reservation', (
         select to_jsonb(x) from (
           select cr.id, cr.order_amount, cr.tip_amount, cr.status,
                  cr.expires_at, cr.psp_reference, cr.round_id
             from contribution_reservations cr
            where cr.participant_id = $2 and cr.status = 'active' and cr.expires_at > now()
            order by cr.created_at desc limit 1) x)
     ) as r
     from sessions se
     join tables t on t.id = se.table_id
     join venues v on v.id = se.venue_id
    where se.id = $1`,
    [sessionId, participantId ?? null]
  )
  return rows[0]?.r ?? null
}

// ---------------------------------------------------------------------------
const ROUTES = {
  'POST /api/join': async (body) =>
    asParticipant(null, (c) =>
      rpc(c, `select open_or_join_session($1,$2) as r`, [body.qr_token, body.nickname])
    ),

  'POST /api/cart/add': async (body) =>
    asParticipant(body.participant_id, (c) =>
      rpc(c, `select add_cart_item($1,$2,$3,$4::int,$5::uuid[]) as r`, [
        body.session_id,
        body.participant_id,
        body.product_id,
        body.quantity ?? 1,
        body.shared_with ?? null,
      ])
    ),

  'POST /api/cart/void': async (body) =>
    asParticipant(body.participant_id, (c) =>
      rpc(c, `select void_cart_item($1,$2) as r`, [body.cart_item_id, body.participant_id])
    ),

  'POST /api/cart/share': async (body) =>
    asParticipant(body.participant_id, (c) =>
      rpc(c, `select set_item_sharing($1,$2::uuid[],$3) as r`, [
        body.cart_item_id,
        body.participant_ids,
        body.participant_id,
      ])
    ),

  'POST /api/round/close': async (body) =>
    asParticipant(body.participant_id, (c) =>
      rpc(c, `select close_round($1,$2) as r`, [body.session_id, body.split_mode ?? 'as_ordered'])
    ),

  'POST /api/reserve': async (body) =>
    asParticipant(body.participant_id, (c) =>
      rpc(c, `select reserve_contribution($1,$2,$3::split_mode,$4,$5::bigint,$6::uuid[],$7::bigint) as r`, [
        body.round_id,
        body.participant_id,
        body.mode,
        body.idempotency_key ?? `web-${Date.now()}-${Math.random()}`,
        body.amount ?? null,
        body.share_ids ?? null,
        body.tip ?? 0,
      ])
    ),

  'POST /api/payments/intent': async (body) => {
    if (!checkoutConfig.publicKey || !checkoutConfig.integritySecret) {
      return {
        status: 'rejected',
        reason: 'wompi_not_configured',
        detail: 'Set WOMPI_PUBLIC_KEY and WOMPI_INTEGRITY_SECRET to get a real checkout link.',
      }
    }
    return createPaymentIntent(pool, {
      reservationId: body.reservation_id,
      config: checkoutConfig,
    })
  },

  // Stands in for Wompi while you have no keys. Goes through the real
  // confirm_webhook, so settlement, dispatch and every invariant behave exactly
  // as they would with a genuine callback.
  'POST /api/dev/pay': async (body) => {
    if (!allowSimulatedPayments) {
      return { status: 'rejected', reason: 'simulated_payments_disabled' }
    }
    // A real rail is configured, so money has to move through it. Settling here
    // would let anyone who can reach this server release food for free.
    if (checkoutConfig.publicKey && checkoutConfig.integritySecret) {
      return { status: 'rejected', reason: 'wompi_configured' }
    }
    const { rows } = await pool.query(
      `select psp_reference, order_amount + tip_amount as total
         from contribution_reservations where id = $1`,
      [body.reservation_id]
    )
    if (rows.length === 0) return { status: 'rejected', reason: 'unknown_reservation' }

    return asParticipant(null, (c) =>
      rpc(c, `select confirm_webhook('wompi',$1,$2,$3,$4::bigint,'{"simulated":true}'::jsonb,true) as r`, [
        `sim-${body.reservation_id}-${Date.now()}`,
        rows[0].psp_reference,
        body.outcome ?? 'approved',
        Number(rows[0].total),
      ])
    )
  },
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const reply = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }

  try {
    if (url.pathname === '/api/state') {
      const state = await tableState(url.searchParams.get('session_id'), url.searchParams.get('participant_id'))
      return state ? reply(200, state) : reply(404, { error: 'unknown_session' })
    }

    const route = ROUTES[`${req.method} ${url.pathname}`]
    if (route) {
      return reply(200, await route(await readBody(req)))
    }

    // Static. `/t/<qr-token>` is what the QR encodes; the page reads the token
    // out of its own path.
    const file = url.pathname.startsWith('/t/') || url.pathname === '/'
      ? 'index.html'
      : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').slice(1)

    const body = await readFile(join(publicDir, file))
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    return res.end(body)
  } catch (err) {
    if (err.code === 'ENOENT') return reply(404, { error: 'not_found' })
    console.error(`[api] ${req.method} ${url.pathname}:`, err.message)
    return reply(500, { error: 'server_error', detail: err.message })
  }
})

function lanAddress() {
  for (const iface of Object.values(networkInterfaces()).flat()) {
    if (iface.family === 'IPv4' && !iface.internal) return iface.address
  }
  return 'localhost'
}

server.listen(port, '0.0.0.0', async () => {
  const { rows } = await pool.query(
    `select t.qr_token, t.label, v.name
       from tables t join venues v on v.id = t.venue_id
      where t.is_active order by v.created_at, t.label limit 1`
  )

  console.log(`\n  Smart Group Tab — servidor en http://${lanAddress()}:${port}\n`)

  if (rows.length === 0) {
    console.log('  No hay mesas. Corré `npm run db:seed` primero.\n')
    return
  }

  const target = `http://${lanAddress()}:${port}/t/${rows[0].qr_token}`
  console.log(`  ${rows[0].name} · ${rows[0].label}`)
  console.log(`  ${target}\n`)
  console.log(await QRCode.toString(target, { type: 'terminal', small: true }))
  console.log('  Escaneá el QR con el celular. Abrilo en dos teléfonos para probar la mesa compartida.')
  console.log(
    checkoutConfig.publicKey && checkoutConfig.integritySecret
      ? '  Wompi configurado: el botón de pagar abre el checkout real. Pagos simulados rechazados.\n'
      : allowSimulatedPayments
        ? '  Pagos simulados activos: el botón de pagar pasa por confirm_webhook real.\n'
        : '  Pagos simulados desactivados.\n')
})

const shutdown = async () => {
  server.close()
  await pool.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
