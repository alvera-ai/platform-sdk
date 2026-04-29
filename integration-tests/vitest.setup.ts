import { beforeAll } from 'vitest'
import { config } from './src/env'

// ---------------------------------------------------------------------------
// Vitest setup — env banner only. The bootstrap chain is no longer here:
// it lives inside each industry's 01-bootstrap.test.ts as Pattern ① (one
// it() per state-machine transition + module-scope state + saveState() per
// step). State files are created externally by `pnpm state:create:<industry>`.
// ---------------------------------------------------------------------------

beforeAll(() => {
  console.log(
    `✓ vitest — env="${config.envName}" baseUrl=${config.baseUrl}`,
  )
})
