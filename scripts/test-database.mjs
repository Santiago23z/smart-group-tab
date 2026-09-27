// Smart Group Tab — which database the tests use.
//
// Never the demo's. Sharing one database put hundreds of test orders on the
// kitchen screen during demos, and let a demo worker steal the tests'
// dispatches. The test database is the demo's name plus `_test`, and anything
// not named that way is refused rather than silently written to.

export const DEFAULT_DATABASE_URL = 'postgres://santiagozapata@localhost:5432/smart_group_tab'

export function testDatabaseUrl(env = process.env) {
  const url = new URL(env.TEST_DATABASE_URL ?? env.DATABASE_URL ?? DEFAULT_DATABASE_URL)
  const name = url.pathname.slice(1)

  if (!env.TEST_DATABASE_URL && !name.endsWith('_test')) {
    url.pathname = `/${name}_test`
  }

  const finalName = url.pathname.slice(1)
  if (!finalName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${finalName}": its name must end in _test.`)
  }
  return url.toString()
}
