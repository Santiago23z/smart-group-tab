// Smart Group Tab — the kitchen display's HTTP surface.
//
// Two audiences, two credentials:
//   /ingest/<channel>   the dispatch worker, with DISPATCH_TOKEN
//   /kds/api/*          the kitchen screen, with KDS_STAFF_TOKEN
//   /kds/*              the screen's static files, which carry no data
//
// Exported as a factory so the tests can run the real thing against the real
// worker on a random port. server.mjs is the shell that reads the environment.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkDelivery } from './ingest.mjs'
import { hasBearer } from './auth.mjs'
import { loadMenu, parseCsv, parseMenu } from '../admin/venue.mjs'

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'kds')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Active tickets, projected field by field. The stored ticket is whatever an
// authenticated sender posted; naming every field here is what keeps anything
// else it might carry — a balance, a reference — off the kitchen's screen.
const ACTIVE_TICKETS = `
  select coalesce(jsonb_agg(jsonb_build_object(
           'round_id',          k.round_id,
           'round_number',      k.ticket -> 'round_number',
           'table',             k.ticket #> '{table,label}',
           'venue',             k.ticket #> '{venue,name}',
           'first_received_at', k.first_received_at,
           'receive_count',     k.receive_count,
           'items', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'name',       i -> 'name',
                      'quantity',   i -> 'quantity',
                      'ordered_by', i -> 'ordered_by')), '[]'::jsonb)
               from jsonb_array_elements(k.ticket -> 'items') i))
         order by k.first_received_at, k.round_id), '[]'::jsonb) as r
    from kitchen_tickets k
   where k.done_at is null`

// Staff actions: path pattern -> the RPC it runs and how to read its arguments.
// Every one answers {status, reason?}; a refusal is 409, an unknown target 404.
const ACTIONS = [
  [/^\/kds\/api\/rounds\/([^/]+)\/cancel$/, 'staff_cancel_round', () => []],
  [/^\/kds\/api\/rounds\/([^/]+)\/resume$/, 'staff_resume_round', () => []],
  [/^\/kds\/api\/reservations\/([^/]+)\/release$/, 'staff_release_reservation', () => []],
  [/^\/kds\/api\/dispatches\/([^/]+)\/retry$/, 'staff_retry_dispatch', () => []],
  [/^\/kds\/api\/refunds\/([^/]+)\/status$/, 'staff_set_refund_status', (b) => [b.status ?? null]],
  [/^\/kds\/api\/sessions\/([^/]+)\/bill$/, 'staff_request_bill', () => []],
  [/^\/kds\/api\/sessions\/([^/]+)\/write-off$/, 'staff_write_off', (b) => [b.reason ?? null]],
  [/^\/kds\/api\/sessions\/([^/]+)\/close$/, 'staff_close_session', () => []],
]

// What the bytes say they are, not what the request claims. Both versions of a
// photo must agree. Nothing is decoded: the staff browser already shrank them.
function imageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

const answer = (r) =>
  r.status !== 'rejected' ? 200 : r.reason?.startsWith('unknown_') ? 404 : 409

async function readBody(req, limitBytes = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    // A menu spreadsheet is a few KB; anything this big is not one.
    if (size > limitBytes) throw Object.assign(new Error('payload too large'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createKdsServer({ pool, dispatchToken, staffToken, stallMinutes = 2, log = console }) {
  if (!dispatchToken || !staffToken) {
    throw new Error('createKdsServer needs both dispatchToken and staffToken')
  }

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0]?.r ?? null

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://kds')
    const reply = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }

    try {
      // -- From the worker ------------------------------------------------
      const ingest = /^\/ingest\/([a-z]+)$/.exec(url.pathname)
      if (ingest && req.method === 'POST') {
        const verdict = checkDelivery({
          channel: ingest[1],
          headers: req.headers,
          rawBody: await readBody(req),
          dispatchToken,
        })
        if (!verdict.ok) return reply(verdict.status, { error: verdict.reason })

        // A printer that does not exist yet is still a destination: answer,
        // so the row reaches a terminal state instead of pending forever.
        if (verdict.channel === 'print') {
          log.log(`  [print] round ${verdict.roundId}`)
          return reply(200, { status: 'acknowledged' })
        }

        // 2xx only after the insert commits. Any database error below is a
        // 5xx, which the worker retries — never a 200 for a ticket not stored.
        try {
          const r = await one(`select kds_ingest($1, $2::jsonb) as r`,
            [verdict.roundId, JSON.stringify(verdict.ticket)])
          return reply(200, r)
        } catch (err) {
          // A round the database does not know is not something to cook.
          if (err.code === '23503') return reply(422, { error: 'unknown_round' })
          throw err
        }
      }

      // -- From the kitchen screen ----------------------------------------
      if (url.pathname.startsWith('/kds/api/')) {
        if (!hasBearer(req.headers, staffToken)) return reply(401, { error: 'staff_only' })

        if (req.method === 'GET' && url.pathname === '/kds/api/state') {
          const [tickets, alerts, collections, openTables] = await Promise.all([
            one(ACTIVE_TICKETS),
            one(`select staff_alerts(make_interval(mins => $1::int)) as r`, [stallMinutes]),
            one(`select staff_collections() as r`),
            one(`select staff_open_tables() as r`),
          ])
          // The screen times tickets against the server's clock, not the
          // tablet's, which nobody in a kitchen will ever set.
          return reply(200, {
            now: new Date().toISOString(), tickets, alerts, collections, open_tables: openTables,
          })
        }

        // -- The venue's menu (minimal self-service) --------------------------
        if (req.method === 'GET' && url.pathname === '/kds/api/venues') {
          const { rows } = await pool.query(`select id, name from venues order by name, created_at`)
          return reply(200, { venues: rows })
        }
        const menuPath = /^\/kds\/api\/venues\/([^/]+)\/menu$/.exec(url.pathname)
        if (menuPath) {
          const venueId = menuPath[1]
          if (!UUID.test(venueId)) return reply(400, { error: 'bad_venue' })
          if ((await pool.query(`select 1 from venues where id = $1`, [venueId])).rowCount === 0) {
            return reply(404, { error: 'unknown_venue' })
          }
          if (req.method === 'GET') {
            const { rows } = await pool.query(
              `select p.id, p.name, p.category, p.unit_price, p.tax_rate, p.is_available, p.sold_out,
                      ph.hash as photo
                 from products p left join product_photos ph on ph.product_id = p.id
                where p.venue_id = $1 order by p.category nulls last, p.name`, [venueId])
            return reply(200, { products: rows })
          }
          if (req.method === 'POST') {
            let body
            try { body = JSON.parse(await readBody(req)) } catch (err) {
              return reply(err.status ?? 400, { error: err.status ? 'too_large' : 'not_json' })
            }
            let menu
            try {
              menu = parseMenu(parseCsv(String(body.csv ?? '')))
            } catch (err) {
              return reply(422, { errors: err.errors ?? [err.message] })
            }
            // Preview and apply run the very same writes; a preview rolls them
            // back, so it can never promise something applying would not do.
            const db = await pool.connect()
            try {
              await db.query('begin')
              const changes = await loadMenu(db, venueId, menu, { dryRun: !body.apply })
              if (body.apply) {
                await db.query(`select staff_log('menu_upload', $1, null, $2::jsonb)`, [venueId, JSON.stringify({
                  added: changes.added.length, updated: changes.updated.length, hidden: changes.hidden.length,
                })])
              }
              await db.query('commit')
              return reply(200, { status: body.apply ? 'applied' : 'preview', ...changes })
            } catch (err) {
              await db.query('rollback').catch(() => {})
              throw err
            } finally {
              db.release()
            }
          }
        }
        const photo = /^\/kds\/api\/venues\/([^/]+)\/products\/([^/]+)\/photo$/.exec(url.pathname)
        if (photo && (req.method === 'PUT' || req.method === 'DELETE')) {
          if (!UUID.test(photo[1]) || !UUID.test(photo[2])) return reply(400, { error: 'bad_id' })
          if (req.method === 'DELETE') {
            const r = await one(`select staff_remove_photo($1, $2) as r`, [photo[1], photo[2]])
            return reply(answer(r), r)
          }
          let body
          try { body = JSON.parse(await readBody(req, 1_200_000)) } catch (err) {
            return reply(err.status ?? 400, { error: err.status ? 'too_large' : 'not_json' })
          }
          const thumb = Buffer.from(String(body.thumb ?? ''), 'base64')
          const large = Buffer.from(String(body.large ?? ''), 'base64')
          const type = imageType(thumb)
          if (!type || imageType(large) !== type) return reply(415, { error: 'not_an_image' })
          const r = await one(`select staff_set_photo($1, $2, $3, $4, $5) as r`, [photo[1], photo[2], thumb, large, type])
          return reply(answer(r), r)
        }

        const soldOut = /^\/kds\/api\/venues\/([^/]+)\/products\/([^/]+)\/sold-out$/.exec(url.pathname)
        if (soldOut && req.method === 'POST') {
          if (!UUID.test(soldOut[1]) || !UUID.test(soldOut[2])) return reply(400, { error: 'bad_id' })
          let body
          try { body = JSON.parse(await readBody(req)) } catch { return reply(400, { error: 'not_json' }) }
          if (typeof body.sold_out !== 'boolean') return reply(400, { error: 'bad_flag' })
          const r = await one(`select staff_set_sold_out($1, $2, $3) as r`, [soldOut[1], soldOut[2], body.sold_out])
          return reply(answer(r), r)
        }

        const done = /^\/kds\/api\/tickets\/([^/]+)\/done$/.exec(url.pathname)
        if (req.method === 'POST' && done) {
          if (!UUID.test(done[1])) return reply(400, { error: 'bad_round' })
          const r = await one(`select kds_mark_done($1) as r`, [done[1]])
          return r ? reply(200, r) : reply(404, { error: 'unknown_ticket' })
        }

        const ack = /^\/kds\/api\/alerts\/([^/]+)\/ack$/.exec(url.pathname)
        if (req.method === 'POST' && ack) {
          if (!UUID.test(ack[1])) return reply(400, { error: 'bad_session' })
          try {
            return reply(200, await one(`select acknowledge_alert($1) as r`, [ack[1]]))
          } catch (err) {
            if (err.code === '23503') return reply(404, { error: 'unknown_session' })
            throw err
          }
        }

        if (req.method === 'POST') {
          let body
          try {
            const raw = await readBody(req)
            body = raw ? JSON.parse(raw) : {}
          } catch {
            return reply(400, { error: 'not_json' })
          }

          if (url.pathname === '/kds/api/refunds') {
            if (!UUID.test(body.contribution_id ?? '')) return reply(400, { error: 'bad_contribution' })
            if (!Number.isSafeInteger(body.amount)) return reply(400, { error: 'bad_amount' })
            const r = await one(`select staff_record_refund($1, $2, $3::bigint, $4, $5) as r`, [
              body.contribution_id, body.kind ?? null, body.amount, body.reason ?? null,
              body.external_reference ?? null,
            ])
            return reply(answer(r), r)
          }

          // Money received in hand: cash or the card terminal. The amount is not
          // sent — the database derives it from the part chosen.
          if (url.pathname === '/kds/api/manual-payments') {
            if (!['round', 'tab'].includes(body.scope)) return reply(400, { error: 'bad_scope' })
            if (!UUID.test(body.target_id ?? '')) return reply(400, { error: 'bad_target' })
            if (body.participant_id != null && !UUID.test(body.participant_id)) return reply(400, { error: 'bad_participant' })
            const tip = body.tip ?? 0
            if (!Number.isSafeInteger(tip)) return reply(400, { error: 'bad_tip' })
            const r = await one(`select staff_record_manual_payment($1, $2, $3, $4, $5, $6::bigint) as r`, [
              body.scope, body.target_id, body.participant_id ?? null, body.method ?? null,
              body.reference ?? null, tip,
            ])
            return reply(answer(r), r)
          }

          for (const [pattern, fn, args] of ACTIONS) {
            const m = pattern.exec(url.pathname)
            if (!m) continue
            if (!UUID.test(m[1])) return reply(400, { error: 'bad_id' })
            const extra = args(body)
            const params = [m[1], ...extra].map((_, i) => `$${i + 1}`).join(', ')
            const r = await one(`select ${fn}(${params}) as r`, [m[1], ...extra])
            return reply(answer(r), r)
          }
        }

        return reply(404, { error: 'not_found' })
      }

      // -- Dish photos, for the Carta panel. Not secret: diners see them too.
      const photoFile = /^\/kds\/photos\/([0-9a-f-]{36})\/([0-9a-f]{16})\/(thumb|large)\.jpg$/.exec(url.pathname)
      if (photoFile && req.method === 'GET') {
        const { rows } = await pool.query(
          `select ${photoFile[3] === 'thumb' ? 'thumb' : 'large'} as bytes, content_type
             from product_photos where product_id = $1 and hash = $2`, [photoFile[1], photoFile[2]])
        if (rows.length === 0) return reply(404, { error: 'not_found' })
        res.writeHead(200, { 'content-type': rows[0].content_type, 'cache-control': 'public, max-age=31536000, immutable' })
        return res.end(rows[0].bytes)
      }

      // -- The screen itself: static, no data -----------------------------
      if (req.method === 'GET' && (url.pathname === '/kds' || url.pathname.startsWith('/kds/'))) {
        const rel = url.pathname === '/kds' || url.pathname === '/kds/'
          ? 'index.html'
          : normalize(url.pathname.slice('/kds/'.length)).replace(/^(\.\.[/\\])+/, '')
        const body = await readFile(join(publicDir, rel))
        res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' })
        return res.end(body)
      }

      return reply(404, { error: 'not_found' })
    } catch (err) {
      if (err.code === 'ENOENT') return reply(404, { error: 'not_found' })
      log.error(`  [kds] ${req.method} ${url.pathname}: ${err.message}`)
      return reply(500, { error: 'server_error' })
    }
  })
}
