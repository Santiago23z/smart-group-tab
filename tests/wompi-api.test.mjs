// Smart Group Tab — asking Wompi directly.
//
// The first outbound call our server makes to Wompi, and the one that carries the
// merchant's private key. Runs against a fake Wompi on localhost: no test here
// touches the network, and none needs a real key.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createWompiApi } from '../src/wompi/api.mjs'

const KEY = 'prv_test_never_print_me'
const TX = { id: '1-2-3', status: 'APPROVED', reference: 'sgt-a', amount_in_cents: 1_000_000, currency: 'COP' }

let server
let base
let seen = []
let respond = () => [200, {}]

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization })
    const [status, body] = respond(req)
    if (status === 'hang') return // never answer
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}/v1`
})

after(() => {
  server.closeAllConnections()
  server.close()
})

const api = (opts = {}) => createWompiApi({ privateKey: KEY, baseUrl: base, ...opts })

test('a transaction is fetched by id with the private key', async () => {
  seen = []
  respond = () => [200, { data: TX }]
  const tx = await api().getTransaction('1-2-3')
  assert.deepEqual(tx, TX)
  assert.equal(seen[0].url, '/v1/transactions/1-2-3')
  assert.equal(seen[0].auth, `Bearer ${KEY}`)
})

test('an id Wompi does not know is null, not an error', async () => {
  respond = () => [404, { error: { type: 'NOT_FOUND_ERROR' } }]
  assert.equal(await api().getTransaction('nope'), null)
})

test('an id cannot reach another path', async () => {
  seen = []
  respond = () => [404, {}]
  await api().getTransaction('../merchants/x?y=1')
  assert.equal(seen[0].url, '/v1/transactions/..%2Fmerchants%2Fx%3Fy%3D1')
})

test('transactions are found by reference', async () => {
  seen = []
  respond = () => [200, { data: [TX] }]
  assert.deepEqual(await api().findByReference('sgt-a&b'), [TX])
  assert.equal(seen[0].url, '/v1/transactions?reference=sgt-a%26b')
  assert.equal(seen[0].auth, `Bearer ${KEY}`)
})

test('a reference with no transactions is an empty list', async () => {
  respond = () => [200, { data: [] }]
  assert.deepEqual(await api().findByReference('sgt-none'), [])
})

test('a server error is thrown and never carries the key', async () => {
  respond = () => [500, { error: { reason: 'boom' } }]
  await assert.rejects(api().findByReference('sgt-a'), (err) => {
    assert.match(err.message, /500/)
    assert.doesNotMatch(err.message + err.stack, new RegExp(KEY))
    return true
  })
})

test('a bad key is an error, not an empty answer', async () => {
  respond = () => [401, { error: { type: 'INVALID_ACCESS_TOKEN' } }]
  await assert.rejects(api().getTransaction('1-2-3'), /401/)
})

test('a Wompi that never answers times out', async () => {
  respond = () => ['hang']
  await assert.rejects(api({ timeoutMs: 100 }).getTransaction('1-2-3'), /timed out/)
})

test('without a key there is no client', () => {
  assert.throws(() => createWompiApi({ privateKey: '' }), /WOMPI_PRIVATE_KEY/)
})
