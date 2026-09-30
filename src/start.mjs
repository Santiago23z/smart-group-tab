#!/usr/bin/env node
// Smart Group Tab — one start command for every service.
//
// On Railway the four services deploy from the same repository with the same
// configuration; each is told which one it is by RONDA_SERVICE. Locally the
// npm scripts (`npm run web`, …) are still the way to start them.

const SERVICES = {
  web: './api/server.mjs',
  wompi: './wompi/server.mjs',
  kds: './kds/server.mjs',
  worker: './worker/server.mjs',
}

const name = process.env.RONDA_SERVICE
if (!SERVICES[name]) {
  console.error(`RONDA_SERVICE must be one of ${Object.keys(SERVICES).join(', ')} (got "${name ?? ''}").`)
  process.exit(1)
}

await import(SERVICES[name])
