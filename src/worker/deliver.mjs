// Smart Group Tab — the delivery call itself.
//
// The only part of the worker that touches a network, and it touches nothing
// else: no database, no configuration lookup, no decision about what happens
// next. URL in, payload in, `{ ok }` out. That is what lets every retry and
// failure path be tested against a stub, and what would make moving delivery to
// an Edge Function a shim rather than a rewrite.

import { summarise } from './outcome.mjs'

/**
 * POST one kitchen ticket.
 *
 * A non-2xx is a failure with the status attached, because "the kitchen display
 * answered 503" and "the kitchen display is unreachable" send a human to two
 * different places.
 *
 * NOTE: HTTP success is the only signal available here. A destination that
 * answers 200 and drops the ticket on the floor is indistinguishable from one
 * that works — which is why the receiving end has to be designed deliberately
 * rather than assumed.
 */
export async function deliver(url, ticket, { channel, timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const control = new AbortController()
  // A kitchen device that accepts the connection and then says nothing would
  // otherwise hold this worker forever, and a hung socket is exactly how an
  // outbox stops being an outbox.
  const timer = setTimeout(() => control.abort(), timeoutMs)

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The receiver's idempotency key. Delivery is at-least-once by
        // construction, so this is what lets a repeat show one order.
        'x-dispatch-round': String(ticket.round_id),
        'x-dispatch-channel': String(channel),
      },
      body: JSON.stringify(ticket),
      signal: control.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: summarise(`HTTP ${res.status} ${res.statusText} ${body}`) }
    }
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: summarise(err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err),
    }
  } finally {
    clearTimeout(timer)
  }
}
