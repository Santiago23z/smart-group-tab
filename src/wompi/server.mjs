#!/usr/bin/env node
// Smart Group Tab — Wompi webhook endpoint.
//
// Deliberately a thin shell. Everything that decides anything lives in
// handler.mjs, signature.mjs and events.mjs, which are plain functions with no
// HTTP in them — that is what makes them testable without a server, and what
// makes porting this to a Supabase Edge Function later a shim rather than a
// rewrite.
//
//   WOMPI_EVENTS_SECRET=... DATABASE_URL=... node src/wompi/server.mjs

import { createServer } from 'node:http'
import pg from 'pg'
import { handleWompiWebhook } from './handler.mjs'
import { createPaymentIntent } from './intent.mjs'
import { createWompiApi } from './api.mjs'
import { reconcileDue } from './reconcile.mjs'

const port = Number(process.env.PORT ?? 8787)
const secret = process.env.WOMPI_EVENTS_SECRET
const connectionString = process.env.DATABASE_URL

// The two secrets are different keys with different jobs, and the failure when
// they are swapped looks like neither. Named apart on purpose.
const checkoutConfig = {
  publicKey: process.env.WOMPI_PUBLIC_KEY,
  integritySecret: process.env.WOMPI_INTEGRITY_SECRET,
  checkoutBaseUrl: process.env.WOMPI_CHECKOUT_URL ?? 'https://checkout.wompi.co/p/',
  redirectUrl: process.env.WOMPI_REDIRECT_URL ?? null,
}

if (!secret) {
  console.error('WOMPI_EVENTS_SECRET is not set. Refusing to start: an endpoint')
  console.error('without a secret would accept forged payments.')
  process.exit(1)
}
if (!checkoutConfig.publicKey || !checkoutConfig.integritySecret) {
  console.error('WOMPI_PUBLIC_KEY and WOMPI_INTEGRITY_SECRET are required to create charges.')
  process.exit(1)
}
if (!connectionString) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString, max: 8 })

// Optional on purpose: without the private key, payments still arrive by
// webhook exactly as before; we just cannot go and look for the ones that don't.
const privateKey = process.env.WOMPI_PRIVATE_KEY
const reconcileSeconds = Number(process.env.WOMPI_RECONCILE_SECONDS ?? 60)
const wompiApi = privateKey
  ? createWompiApi({ privateKey, baseUrl: process.env.WOMPI_API_URL ?? 'https://sandbox.wompi.co/v1' })
  : null
let reconcileTimer = null

async function reconcileLoop() {
  try {
    await reconcileDue(pool, { api: wompiApi, intervalSeconds: reconcileSeconds, log: console.log })
  } catch (err) {
    // The database, most likely. Rows stay due, so the next pass picks them up.
    console.error('[reconcile] pass failed:', err.message)
  } finally {
    reconcileTimer = setTimeout(reconcileLoop, reconcileSeconds * 1000)
  }
}

async function readBody(req, limitBytes = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('payload too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const server = createServer(async (req, res) => {
  const reply = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  const isWebhook = req.url.startsWith('/webhooks/wompi')
  const isIntent = req.url.startsWith('/payments/intent')

  if (req.method !== 'POST' || (!isWebhook && !isIntent)) {
    return reply(404, { status: 'not_found' })
  }

  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return reply(400, { status: 'malformed', reason: 'body is not JSON' })
  }

  if (isIntent) {
    try {
      const intent = await createPaymentIntent(pool, {
        reservationId: body.reservation_id,
        config: checkoutConfig,
      })
      return reply(intent.status === 'created' ? 200 : 409, intent)
    } catch (err) {
      console.error('[wompi] could not build a checkout:', err.message)
      return reply(500, { status: 'error' })
    }
  }

  try {
    const { httpStatus, result } = await handleWompiWebhook({ body, secret, pool })
    return reply(httpStatus, result)
  } catch (err) {
    // 500 on purpose: it is the only answer that makes Wompi retry, and a
    // database that is momentarily down must not silently lose a real payment.
    console.error('[wompi] delivery failed, asking for a retry:', err.message)
    return reply(500, { status: 'error' })
  }
})

server.listen(port, () => {
  console.log(`Wompi bridge listening on http://localhost:${port}`)
  console.log(`  POST /payments/intent   build a checkout for a live reservation`)
  console.log(`  POST /webhooks/wompi    settle what Wompi sends back`)
  if (wompiApi) {
    console.log(`  Reconciliation on: asking Wompi every ${reconcileSeconds}s about unsettled checkouts`)
    reconcileLoop()
  } else {
    console.log('  Reconciliation disabled: WOMPI_PRIVATE_KEY is not set (webhooks only)')
  }
})

const shutdown = async () => {
  clearTimeout(reconcileTimer)
  server.close()
  await pool.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
