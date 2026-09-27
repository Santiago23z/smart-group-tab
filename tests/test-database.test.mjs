// Smart Group Tab — tests never touch the demo's database.
//
// Tests and the live demo used to share one database, so the kitchen screen in
// a demo showed hundreds of test orders, and a demo worker left running stole
// the tests' dispatches. Now the tests derive their own database, and refuse to
// run against any database whose name does not say it is for tests.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { testDatabaseUrl } from '../scripts/test-database.mjs'

test('the test database is the demo database with _test appended', () => {
  assert.equal(
    testDatabaseUrl({ DATABASE_URL: 'postgres://me@localhost:5432/smart_group_tab' }),
    'postgres://me@localhost:5432/smart_group_tab_test'
  )
})

test('without DATABASE_URL the local default gets _test too', () => {
  assert.match(testDatabaseUrl({}), /\/smart_group_tab_test$/)
})

test('a database already named for tests is used as is', () => {
  assert.equal(
    testDatabaseUrl({ DATABASE_URL: 'postgres://me@localhost:5432/x_test' }),
    'postgres://me@localhost:5432/x_test'
  )
})

test('TEST_DATABASE_URL wins', () => {
  assert.equal(
    testDatabaseUrl({ DATABASE_URL: 'postgres://me@h/a', TEST_DATABASE_URL: 'postgres://me@h/b_test' }),
    'postgres://me@h/b_test'
  )
})

test('an explicit test database not named for tests is refused', () => {
  assert.throws(
    () => testDatabaseUrl({ TEST_DATABASE_URL: 'postgres://me@h/smart_group_tab' }),
    /must end in _test/
  )
})
