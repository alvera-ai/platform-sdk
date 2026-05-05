/**
 * CLI resource tests — validates CRUD operations via the CLI produce equivalent
 * results to the SDK-based tests.
 *
 * Requires: SDK healthcare suite to have completed (reads multiple state files).
 */
import { describe, beforeAll, expect, it } from 'vitest'
import { cliJson } from '../../src/cli-runner'
import {
  type BootstrapState,
  type DataSourcesState,
  type ToolsState,
  type Industry,
  requireSpec,
  loadSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'

let bootstrap: BootstrapState
let dataSources: DataSourcesState | null
let tools: ToolsState | null
let cliOpts: { sessionToken: string; tenant: string }

beforeAll(() => {
  bootstrap = requireSpec(INDUSTRY, 'bootstrap')
  dataSources = loadSpec(INDUSTRY, 'data-sources')
  tools = loadSpec(INDUSTRY, 'tools')

  if (!bootstrap.sarahSessionToken || !bootstrap.tenantSlug) {
    throw new Error('bootstrap state incomplete')
  }
  cliOpts = {
    sessionToken: bootstrap.sarahSessionToken,
    tenant: bootstrap.tenantSlug,
  }
})

describe('CLI resources', () => {
  describe('datalakes', () => {
    it('list returns array', async () => {
      const data = await cliJson(['datalakes', 'list'], cliOpts) as { data: unknown[] }
      expect(Array.isArray(data.data)).toBe(true)
      expect(data.data.length).toBeGreaterThan(0)
    })

    it('get by id returns matching datalake', async () => {
      const data = await cliJson(
        ['datalakes', 'get', bootstrap.datalakeId!],
        cliOpts,
      ) as { data: { id: string } }
      expect(data.data.id).toBe(bootstrap.datalakeId)
    })
  })

  describe('data-sources', () => {
    it('list returns array', async () => {
      const data = await cliJson(
        ['data-sources', 'list', bootstrap.datalakeSlug!],
        cliOpts,
      ) as { data: unknown[] }
      expect(Array.isArray(data.data)).toBe(true)
    })
  })

  describe('tools', () => {
    it('list returns array', async () => {
      const data = await cliJson(['tools', 'list'], cliOpts) as { data: unknown[] }
      expect(Array.isArray(data.data)).toBe(true)
    })

    it('get by id matches state', async () => {
      if (!tools?.manualUploadToolId) return
      const data = await cliJson(
        ['tools', 'get', tools.manualUploadToolId],
        cliOpts,
      ) as { data: { id: string } }
      expect(data.data.id).toBe(tools.manualUploadToolId)
    })
  })

  describe('ai-agents', () => {
    it('list returns array', async () => {
      const data = await cliJson(
        ['ai-agents', 'list', bootstrap.datalakeSlug!],
        cliOpts,
      ) as { data: unknown[] }
      expect(Array.isArray(data.data)).toBe(true)
    })
  })

  describe('datasets search', () => {
    it('search with --data-access-mode unregulated', async () => {
      const data = await cliJson(
        ['datasets', 'search', 'patient', '--data-access-mode', 'unregulated'],
        cliOpts,
      ) as { data: unknown }
      expect(data).toHaveProperty('data')
    })

    it('search with --data-access-mode regulated', async () => {
      const data = await cliJson(
        ['datasets', 'search', 'patient', '--data-access-mode', 'regulated'],
        cliOpts,
      ) as { data: unknown }
      expect(data).toHaveProperty('data')
    })
  })
})
