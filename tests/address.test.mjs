// Smart Group Tab — the address printed in the QR.
//
// Wompi's firewall refuses the whole checkout when the way back names an IP
// address, and the way back is the address the phone used. A QR carrying the
// LAN IP therefore meant a diner who never got back to their table after
// paying. The Mac's .local name reaches the same machine and passes.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reachableHost } from '../src/api/address.mjs'

test('a .local host name is preferred over the IP', () => {
  assert.equal(reachableHost('santiagos-MacBook-Air.local', '192.168.1.132'), 'santiagos-MacBook-Air.local')
})

test('a bare host name falls back to the IP: it may not resolve on a phone', () => {
  assert.equal(reachableHost('build-box', '10.0.0.5'), '10.0.0.5')
})

test('no host name at all falls back to the IP', () => {
  assert.equal(reachableHost('', '10.0.0.5'), '10.0.0.5')
})
