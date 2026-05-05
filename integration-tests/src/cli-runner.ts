import { execFile } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './env'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SDK_ROOT = resolve(__dirname, '../..')
const CLI_PATH = resolve(SDK_ROOT, 'src/cli.ts')
const TSX_BIN = resolve(SDK_ROOT, 'node_modules/.bin/tsx')

export interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
  json: unknown
}

export interface CliOptions {
  sessionToken?: string
  baseUrl?: string
  tenant?: string
  timeout?: number
  stdin?: string
}

export function runCli(args: string[], opts: CliOptions = {}): Promise<CliResult> {
  const timeout = opts.timeout ?? 30_000
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ALVERA_ENV: config.envName,
    ALVERA_BASE_URL: opts.baseUrl ?? config.baseUrl,
  }
  if (opts.sessionToken) env.ALVERA_SESSION_TOKEN = opts.sessionToken
  if (opts.tenant) env.ALVERA_TENANT = opts.tenant

  return new Promise((res) => {
    const child = execFile(
      TSX_BIN,
      [CLI_PATH, ...args],
      { env, timeout, maxBuffer: 10 * 1024 * 1024, cwd: SDK_ROOT },
      (error, stdout, stderr) => {
        let exitCode = 0
        if (error) {
          exitCode = (error as { status?: number }).status ?? 1
        }
        let json: unknown = null
        try {
          json = JSON.parse(stdout)
        } catch { /* not json */ }
        res({ stdout, stderr, exitCode, json })
      },
    )
    if (opts.stdin && child.stdin) {
      child.stdin.write(opts.stdin)
      child.stdin.end()
    }
  })
}

export async function cliJson(args: string[], opts?: CliOptions): Promise<unknown> {
  const result = await runCli(args, opts)
  if (result.exitCode !== 0) {
    throw new Error(
      `CLI exited ${result.exitCode}: ${result.stderr || result.stdout}` +
      `\n  command: alvera ${args.join(' ')}`,
    )
  }
  if (result.json === null) {
    throw new Error(
      `CLI stdout was not valid JSON:\n${result.stdout}` +
      `\n  command: alvera ${args.join(' ')}`,
    )
  }
  return result.json
}
