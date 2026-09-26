// Asking Wompi what happened to a payment, instead of waiting to be told.
//
// The webhook is the normal way we learn an outcome; this is the fallback for
// when it never comes. It carries the merchant's private key, so the key goes in
// the header and nowhere else: never in a URL, a log line or an error message.

export class WompiApiError extends Error {}

/**
 * Both lookups were verified against the sandbox on 2026-09-26:
 *   GET /transactions/{id}            -> { data: <transaction> }
 *   GET /transactions?reference=<ref> -> { data: [<transaction>, ...] }
 * Only the first is in Wompi's public docs.
 */
export function createWompiApi({
  privateKey,
  baseUrl = 'https://sandbox.wompi.co/v1',
  timeoutMs = 10_000,
  fetchImpl = fetch,
}) {
  if (!privateKey) {
    throw new Error('WOMPI_PRIVATE_KEY is not set; cannot ask Wompi about transactions')
  }

  async function get(path) {
    let response
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers: { authorization: `Bearer ${privateKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      // Rethrown with our own message: the original can be anything, and we do
      // not want to find out later that one of them echoed the request headers.
      const reason = err.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : 'unreachable'
      throw new WompiApiError(`Wompi ${reason} on GET ${path}`)
    }

    if (response.status === 404) return null
    if (!response.ok) {
      throw new WompiApiError(`Wompi answered ${response.status} on GET ${path}`)
    }
    return (await response.json()).data
  }

  return {
    getTransaction: (id) => get(`/transactions/${encodeURIComponent(id)}`),
    findByReference: async (reference) =>
      (await get(`/transactions?reference=${encodeURIComponent(reference)}`)) ?? [],
  }
}
