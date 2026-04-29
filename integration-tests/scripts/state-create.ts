#!/usr/bin/env tsx
/**
 * state-create — initialise per-run state for one industry.
 *
 *   pnpm state:create:healthcare
 *
 * Writes:
 *   vitest-state/<industry>/base.state.json   names + creds (overwritten)
 *   vitest-state/<industry>/current.txt       new runId pointer
 *   vitest-state/<industry>/<runId>/          empty subdir for spec writes
 *
 * Tests NEVER compute the runId — they read current.txt. State-create is
 * the sole authority on "what run am I in." Refuses to overwrite an active
 * runId pointer unless --force is passed (so a half-finished suite isn't
 * silently abandoned).
 *
 * Old runId subdirs are preserved on disk as an audit trail; clean them out
 * with `pnpm state:clear:<industry>` when they pile up.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import type { BaseState, Industry } from '../src/state.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const STATE_ROOT = resolve(ROOT, 'vitest-state')

const INDUSTRY_LABELS: Record<Industry, string> = {
  healthcare: 'Healthcare',
  accounts_receivable: 'Accounts Receivable',
  payment_risk: 'Payment Risk',
}

const INDUSTRY_DATALAKE_NAMES: Record<Industry, string> = {
  healthcare: 'Healthcare Lake',
  accounts_receivable: 'Accounts Receivable Lake',
  payment_risk: 'Payment Risk Lake',
}

// Resource names per industry — Playwright's healthcare suite uses these
// verbatim. Mirroring keeps the two suites swappable for the same fixtures.
const HEALTHCARE_RESOURCE_NAMES = {
  dataSourceName: 'Athena Health EMR',
  interopTemplateName: 'Athena Appt Mapping',
  dacName: 'CAHPS Manual Reconciliation',
  cloudWatchToolName: 'CW Status Checker',
  snsToolName: 'SNS SMS Tool',
  lambdaToolName: 'Athena Reports Lambda',
} as const

// ─── env file parsing (dev.env, etc.) ───────────────────────────────────────

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  return out
}

function readEnvVars(): Record<string, string | undefined> {
  return { ...parseEnvFile(resolve(ROOT, 'dev.env')), ...process.env }
}

function requireVar(name: string, env: Record<string, string | undefined>): string {
  const v = env[name]
  if (!v) throw new Error(`Missing ${name} — check integration-tests/dev.env`)
  return v
}

function buildEmail(prefix: string, name: string, runId: string, industry: Industry): string {
  return `${prefix}-${name}-${runId}-${industry}@e2e.local`
}

const VALID_INDUSTRIES = Object.keys(INDUSTRY_LABELS) as Industry[]

function isIndustry(v: string | undefined): v is Industry {
  return v !== undefined && (VALID_INDUSTRIES as string[]).includes(v)
}

// ─── main ───────────────────────────────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2)
  const force = argv.includes('--force')
  const industryArg = argv.find((a: string) => !a.startsWith('--'))

  if (!isIndustry(industryArg)) {
    console.error(
      `Usage: tsx scripts/state-create.ts <industry> [--force]\n` +
        `  industry: ${VALID_INDUSTRIES.join(' | ')}`,
    )
    process.exit(1)
  }
  const industry: Industry = industryArg

  const industryDir = resolve(STATE_ROOT, industry)
  const pointer = resolve(industryDir, 'current.txt')

  // Refuse to overwrite a pointer that already names a runId — tells the
  // caller they're about to throw away an in-flight session. --force opts in.
  if (existsSync(pointer) && !force) {
    const existing = readFileSync(pointer, 'utf8').trim()
    console.error(
      `An active runId already exists for industry "${industry}": ${existing}\n` +
        `Old run state lives at vitest-state/${industry}/${existing}/.\n` +
        `Pass --force to start a NEW runId (old subdir is preserved on disk),\n` +
        `or run \`pnpm state:clear:${industry}\` to wipe the whole industry directory.`,
    )
    process.exit(1)
  }

  const env = readEnvVars()
  const adminPrefix = requireVar('ALVERA_TEST_ADMIN_EMAIL_PREFIX', env)
  const adminPassword = requireVar('ALVERA_TEST_ADMIN_PASSWORD', env)
  const tenantPrefix = requireVar('ALVERA_TEST_TENANT_PREFIX', env)

  const runId = String(Date.now())
  const label = INDUSTRY_LABELS[industry]

  const base: BaseState = {
    runId,
    industry,

    sarahEmail: buildEmail(adminPrefix, 'sarah', runId, industry),
    sarahPassword: adminPassword,
    tenantName: `${tenantPrefix} ${label} ${runId}`,
    datalakeName: INDUSTRY_DATALAKE_NAMES[industry],

    emmaEmail: buildEmail(adminPrefix, 'emma', runId, industry),
    jamesEmail: buildEmail(adminPrefix, 'james', runId, industry),

    ...HEALTHCARE_RESOURCE_NAMES,
    updaterName: `Status Updater ${runId}`,
  }

  if (!existsSync(industryDir)) mkdirSync(industryDir, { recursive: true })
  // Ensure the per-run subdir exists upfront so specs don't race on first write.
  mkdirSync(resolve(industryDir, runId), { recursive: true })

  writeFileSync(resolve(industryDir, 'base.state.json'), JSON.stringify(base, null, 2))
  writeFileSync(pointer, `${runId}\n`)

  console.log(`✓ vitest-state/${industry}/base.state.json updated`)
  console.log(`✓ vitest-state/${industry}/current.txt → ${runId}`)
  console.log(`✓ vitest-state/${industry}/${runId}/   (per-spec writes will land here)`)
  console.log(``)
  console.log(`  sarahEmail  = ${base.sarahEmail}`)
  console.log(`  tenantName  = ${base.tenantName}`)
}

main()
