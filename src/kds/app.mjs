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

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
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
          const [tickets, alerts] = await Promise.all([
            one(ACTIVE_TICKETS),
            one(`select staff_alerts(make_interval(mins => $1::int)) as r`, [stallMinutes]),
          ])
          // The screen times tickets against the server's clock, not the
          // tablet's, which nobody in a kitchen will ever set.
          return reply(200, { now: new Date().toISOString(), tickets, alerts })
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

        return reply(404, { error: 'not_found' })
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
