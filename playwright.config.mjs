// Smart Group Tab — browser tests for the diner's PWA and the kitchen screen.
//
// The node tests cover the database and the HTTP shells. None of them render
// anything, which is how a CSS rule that left three overlays permanently on
// screen shipped in the first commit and survived every green run since. These
// drive a real browser against the real servers against the real database.

import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 8791)
const KDS_PORT = Number(process.env.E2E_KDS_PORT ?? 8792)
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://santiagozapata@localhost:5432/smart_group_tab'

// Fixed test credentials. tests/e2e/kds.spec.mjs uses the same two literals.
const E2E_DISPATCH_TOKEN = 'e2e-dispatch-token'
const E2E_STAFF_TOKEN = 'e2e-staff-token'

export default defineConfig({
  testDir: './tests/e2e',
  // The table is shared state: two specs closing rounds on the same session
  // would race each other, not the code under test. Concurrency is exercised
  // deliberately inside a spec, with two browser contexts, not across specs.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'diner',
      testMatch: 'diner.spec.mjs',
      // A diner is on a phone, and the layout is built for one.
      use: { ...devices['iPhone 13'], baseURL: `http://127.0.0.1:${PORT}` },
    },
    {
      name: 'kitchen',
      testMatch: 'kds.spec.mjs',
      // A tablet on a kitchen wall, landscape. WebKit like the diner, so one
      // `npx playwright install webkit` covers both.
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 },
             baseURL: `http://127.0.0.1:${KDS_PORT}` },
    },
  ],
  webServer: [
    {
      command: 'node src/api/server.mjs',
      url: `http://127.0.0.1:${PORT}/t/qr-test-mesa-01`,
      reuseExistingServer: false,
      env: { DATABASE_URL, PORT: String(PORT), ALLOW_SIMULATED_PAYMENTS: 'true' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node src/kds/server.mjs',
      url: `http://127.0.0.1:${KDS_PORT}/kds`,
      reuseExistingServer: false,
      env: {
        DATABASE_URL, KDS_PORT: String(KDS_PORT),
        DISPATCH_TOKEN: E2E_DISPATCH_TOKEN, KDS_STAFF_TOKEN: E2E_STAFF_TOKEN,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
