#!/usr/bin/env tsx
/**
 * state-clear — wipe the state directory for an industry.
 *
 *   pnpm state:clear:healthcare
 *
 * Removes vitest-state/<industry>/ entirely (base + current.txt + every
 * runId subdir). Does NOT touch server-side state — run `make db-reset`
 * separately if you also need to wipe Phoenix's tenants/datalakes.
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_ROOT = resolve(__dirname, '../vitest-state')

const VALID = ['healthcare', 'accounts_receivable', 'payment_risk'] as const

function main(): void {
  const industry = process.argv[2] as (typeof VALID)[number] | undefined
  if (!industry || !VALID.includes(industry)) {
    console.error(`Usage: tsx scripts/state-clear.ts <${VALID.join(' | ')}>`)
    process.exit(1)
  }
  const dir = resolve(STATE_ROOT, industry)
  if (!existsSync(dir)) {
    console.log(`Nothing to clear — ${dir} doesn't exist`)
    return
  }
  rmSync(dir, { recursive: true, force: true })
  console.log(`✓ Cleared ${dir}`)
}

main()
