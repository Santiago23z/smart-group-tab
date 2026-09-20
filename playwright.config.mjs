// Smart Group Tab — browser tests for the diner's PWA.
//
// The 88 node tests cover the database and the HTTP shell. None of them render
// anything, which is how a CSS rule that left three overlays permanently on
// screen shipped in the first commit and survived every green run since. These
// drive a real browser against the real server against the real database.

import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 8791)
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://santiagozapata@localhost:5432/smart_group_tab'

export default defineConfig({
  testDir: './tests/e2e',
  // The table is shared state: two specs closing rounds on the same session
  // would race each other, not the code under test. Concurrency is exercised
  // deliberately inside a spec, with two browser contexts, not across specs.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // A diner is on a phone, and the layout is built for one.
    ...devices['iPhone 13'],
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node src/api/server.mjs',
    url: `http://127.0.0.1:${PORT}/t/qr-test-mesa-01`,
    reuseExistingServer: false,
    env: { DATABASE_URL, PORT: String(PORT), ALLOW_SIMULATED_PAYMENTS: 'true' },
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
