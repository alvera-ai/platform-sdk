/**
 * CLI raw command tests — validates the escape hatch for bypassing SDK validation.
 *
 * Requires: SDK healthcare bootstrap to have run.
 */
import { describe, beforeAll, expect, it } from 'vitest'
import { runCli, cliJson } from '../../src/cli-runner'
import {
  type BootstrapState,
  type ToolsState,
  type Industry,
  requireSpec,
  loadSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'

let bootstrap: BootstrapState
let tools: ToolsState | null
let cliOpts: { sessionToken: string; tenant: string }

beforeAll(() => {
  bootstrap = requireSpec(INDUSTRY, 'bootstrap')
  tools = loadSpec(INDUSTRY, 'tools')
  if (!bootstrap.sarahSessionToken || !bootstrap.tenantSlug) {
    throw new Error('bootstrap state incomplete')
  }
  cliOpts = {
    sessionToken: bootstrap.sarahSessionToken,
    tenant: bootstrap.tenantSlug,
  }
})

describe('CLI raw command', () => {
  it('GET /api/ping returns server info', async () => {
    const data = await cliJson(['raw', 'GET', '/api/ping'], cliOpts)
    expect(data).toBeTruthy()
  })

  it('GET a resource by path returns valid JSON', async () => {
    const path = `/api/v1/tenants/${bootstrap.tenantSlug}/datalakes`
    const data = await cliJson(['raw', 'GET', path], cliOpts) as { data: unknown[] }
    expect(Array.isArray(data.data)).toBe(true)
  })

  it('GET tool by id via raw matches SDK get', async () => {
    if (!tools?.manualUploadToolId) return
    const path = `/api/v1/tenants/${bootstrap.tenantSlug}/tools/${tools.manualUploadToolId}`
    const data = await cliJson(['raw', 'GET', path], cliOpts) as { data: { id: string } }
    expect(data.data.id).toBe(tools.manualUploadToolId)
  })

  it('non-2xx exits non-zero with error in stderr', async () => {
    const result = await runCli(
      ['raw', 'GET', '/api/v1/nonexistent-endpoint'],
      cliOpts,
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('404')
  })

  it('invalid method is rejected', async () => {
    const result = await runCli(['raw', 'TRACE', '/api/ping'], cliOpts)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('invalid method')
  })

  it('POST with --body sends JSON payload', async () => {
    const path = `/api/v1/tenants/${bootstrap.tenantSlug}/datalakes/${bootstrap.datalakeSlug}/ai-agents`
    const body = JSON.stringify({
      name: 'cli-raw-test-agent',
      model: 'gpt-4o',
      prompt: 'test prompt for CLI raw command integration test',
    })
    const data = await cliJson(
      ['raw', 'POST', path, '--body', body],
      cliOpts,
    ) as { data: { id: string; name: string } }
    expect(data.data.id).toBeTruthy()
    expect(data.data.name).toBe('cli-raw-test-agent')

    // Cleanup: delete the created agent
    const deletePath = `/api/v1/tenants/${bootstrap.tenantSlug}/datalakes/${bootstrap.datalakeSlug}/ai-agents/${data.data.id}`
    await cliJson(['raw', 'DELETE', deletePath], cliOpts)
  })

  it('POST with --body-file - reads from stdin', async () => {
    const path = `/api/v1/tenants/${bootstrap.tenantSlug}/datalakes/${bootstrap.datalakeSlug}/ai-agents`
    const body = JSON.stringify({
      name: 'cli-raw-stdin-agent',
      model: 'gpt-4o',
      prompt: 'test prompt via stdin',
    })
    const data = await cliJson(
      ['raw', 'POST', path, '--body-file', '-'],
      { ...cliOpts, stdin: body },
    ) as { data: { id: string; name: string } }
    expect(data.data.id).toBeTruthy()
    expect(data.data.name).toBe('cli-raw-stdin-agent')

    // Cleanup
    const deletePath = `/api/v1/tenants/${bootstrap.tenantSlug}/datalakes/${bootstrap.datalakeSlug}/ai-agents/${data.data.id}`
    await cliJson(['raw', 'DELETE', deletePath], cliOpts)
  })
})
