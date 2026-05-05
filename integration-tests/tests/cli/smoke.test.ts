/**
 * CLI smoke tests — validates basic connectivity and auth via the CLI binary.
 *
 * Requires: SDK healthcare bootstrap to have run (reads sarahSessionToken).
 */
import { describe, beforeAll, expect, it } from 'vitest'
import { runCli, cliJson } from '../../src/cli-runner'
import {
  type BootstrapState,
  type Industry,
  requireSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'

let bootstrap: BootstrapState
let cliOpts: { sessionToken: string; tenant: string }

beforeAll(() => {
  bootstrap = requireSpec(INDUSTRY, 'bootstrap')
  if (!bootstrap.sarahSessionToken || !bootstrap.tenantSlug) {
    throw new Error('bootstrap state missing sarahSessionToken or tenantSlug')
  }
  cliOpts = {
    sessionToken: bootstrap.sarahSessionToken,
    tenant: bootstrap.tenantSlug,
  }
})

describe('CLI smoke', () => {
  it('--version prints semver', async () => {
    const result = await runCli(['--version'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('ping reaches the server', async () => {
    const data = await cliJson(['ping'], cliOpts)
    expect(data).toBeTruthy()
  })

  it('whoami returns profile info', async () => {
    const data = await cliJson(['whoami'], cliOpts) as Record<string, unknown>
    expect(data.hasSessionToken).toBe(true)
  })

  it('sessions-verify confirms valid session', async () => {
    const data = await cliJson(['sessions-verify'], cliOpts) as Record<string, unknown>
    expect(data).toHaveProperty('data_access_mode')
  })
})
