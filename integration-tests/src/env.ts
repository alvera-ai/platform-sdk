import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// Environment catalogue
//
// Mirrors `lib/platform_api/api_spec.ex` servers/0 — kept in sync via the
// SDK's gen-environments.ts script. Tests default to `local` (NOT prod) —
// running the integration suite against prod by accident is a foot-gun.
// ---------------------------------------------------------------------------

const ENVIRONMENTS = {
  local: { baseUrl: 'http://localhost:4000', description: 'Development server' },
  demo: { baseUrl: 'https://platform-hh.alvera.ai', description: 'Himangshu Demo server' },
  prod: { baseUrl: 'https://app.alvera.ai', description: 'Prod Server' },
} as const satisfies Readonly<Record<string, { baseUrl: string; description: string }>>

export type EnvironmentName = keyof typeof ENVIRONMENTS

const DEFAULT_ENVIRONMENT: EnvironmentName = 'local'

// ---------------------------------------------------------------------------
// .env loading — minimal, no dotenv dep. Reads ${envName}.env (if present)
// then falls back to dev.env (committed). process.env always wins.
// ---------------------------------------------------------------------------

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    out[key] = val.replace(/^["']|["']$/g, '')
  }
  return out
}

function pickEnvName(): EnvironmentName {
  const raw = process.env.ALVERA_ENV ?? readEnvFromFiles().ALVERA_ENV ?? DEFAULT_ENVIRONMENT
  if (!(raw in ENVIRONMENTS)) {
    const valid = Object.keys(ENVIRONMENTS).join(', ')
    throw new Error(`Unknown ALVERA_ENV="${raw}". Valid: ${valid}`)
  }
  return raw as EnvironmentName
}

function readEnvFromFiles(): Record<string, string> {
  // dev.env is the committed baseline; ${envName}.env overrides it per-developer.
  const baseline = parseEnvFile(resolve(ROOT, 'dev.env'))
  const envFile =
    process.env.ALVERA_ENV && process.env.ALVERA_ENV !== 'dev'
      ? parseEnvFile(resolve(ROOT, `${process.env.ALVERA_ENV}.env`))
      : {}
  return { ...baseline, ...envFile }
}

function requireVar(name: string, fileVars: Record<string, string>): string {
  const value = process.env[name] ?? fileVars[name]
  if (!value || value.length === 0) {
    throw new Error(
      `Missing required env var ${name}. ` +
        `Check integration-tests/dev.env or set it in your shell.`,
    )
  }
  return value
}

// ---------------------------------------------------------------------------
// Hard-fail guards
// ---------------------------------------------------------------------------

function buildConfig() {
  const envName = pickEnvName()
  const env = ENVIRONMENTS[envName]
  const fileVars = readEnvFromFiles()

  if (envName === 'prod') {
    throw new Error(
      `ALVERA_ENV=prod is not supported by integration-tests — ` +
        `running the bootstrap against prod would create real tenants. ` +
        `Use local or demo.`,
    )
  }

  return {
    envName,
    envDescription: env.description,
    baseUrl: env.baseUrl,
    rootEmail: requireVar('ALVERA_TEST_ROOT_EMAIL', fileVars),
    rootPassword: requireVar('ALVERA_TEST_ROOT_PASSWORD', fileVars),
    adminEmailPrefix: requireVar('ALVERA_TEST_ADMIN_EMAIL_PREFIX', fileVars),
    adminPassword: requireVar('ALVERA_TEST_ADMIN_PASSWORD', fileVars),
    tenantPrefix: requireVar('ALVERA_TEST_TENANT_PREFIX', fileVars),
    ollamaModel: requireVar('ALVERA_TEST_OLLAMA_MODEL', fileVars),
  } as const
}

export const config = buildConfig()
export type Config = typeof config
