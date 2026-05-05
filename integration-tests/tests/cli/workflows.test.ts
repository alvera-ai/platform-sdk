/**
 * CLI workflow tests — validates workflow operations + the new --data-access-mode
 * flag on workflow-log, plus artifact download via datalakes download-link.
 *
 * Requires: SDK healthcare suite to have completed through standard-workflow.
 */
import { describe, beforeAll, expect, it } from 'vitest'
import { cliJson } from '../../src/cli-runner'
import {
  type BootstrapState,
  type StandardWorkflowState,
  type Industry,
  requireSpec,
  loadSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'

let bootstrap: BootstrapState
let stdWorkflow: StandardWorkflowState | null
let cliOpts: { sessionToken: string; tenant: string }

beforeAll(() => {
  bootstrap = requireSpec(INDUSTRY, 'bootstrap')
  stdWorkflow = loadSpec(INDUSTRY, 'standard-workflow')

  if (!bootstrap.sarahSessionToken || !bootstrap.tenantSlug) {
    throw new Error('bootstrap state incomplete')
  }
  cliOpts = {
    sessionToken: bootstrap.sarahSessionToken,
    tenant: bootstrap.tenantSlug,
  }
})

describe('CLI workflows', () => {
  it('list returns array', async () => {
    const data = await cliJson(
      ['workflows', 'list', bootstrap.datalakeSlug!],
      cliOpts,
    ) as { data: unknown[] }
    expect(Array.isArray(data.data)).toBe(true)
  })

  it('get by id matches state', async () => {
    if (!stdWorkflow?.workflowId) return
    const data = await cliJson(
      ['workflows', 'get', bootstrap.datalakeSlug!, stdWorkflow.workflowId],
      cliOpts,
    ) as { data: { id: string } }
    expect(data.data.id).toBe(stdWorkflow.workflowId)
  })

  describe('workflow-log with --data-access-mode', () => {
    it('regulated mode returns log data', async () => {
      if (!stdWorkflow?.workflowSlug || !stdWorkflow?.lastWorkflowRunLogId) return
      const data = await cliJson(
        [
          'workflows', 'workflow-log',
          stdWorkflow.workflowSlug,
          stdWorkflow.lastWorkflowRunLogId,
          '--data-access-mode', 'regulated',
        ],
        cliOpts,
      ) as { data: { id: string } }
      expect(data.data.id).toBe(stdWorkflow.lastWorkflowRunLogId)
    })
  })

  describe('batch-log-refresh (single call, no poll)', () => {
    it('returns batch log status', async () => {
      if (!stdWorkflow?.workflowSlug || !stdWorkflow?.lastWorkflowRunLogId) return
      const data = await cliJson(
        [
          'workflows', 'batch-log-refresh',
          stdWorkflow.workflowSlug,
          stdWorkflow.lastWorkflowRunLogId,
        ],
        cliOpts,
      ) as { data: { status: string } }
      expect(data.data.status).toBeTruthy()
    })
  })

  describe('artifact download via download-link', () => {
    it('download-link returns presigned URL', async () => {
      if (!stdWorkflow?.workflowId || !stdWorkflow?.lastWorkflowRunLogId) return
      const bucket = 'healthcare-lake-regulated'
      const key = `workflows/${stdWorkflow.workflowId}/executions/${stdWorkflow.lastWorkflowRunLogId}/filter.json`
      const data = await cliJson(
        ['datalakes', 'download-link', bootstrap.datalakeSlug!, bucket, key],
        cliOpts,
      ) as { data: { url: string } }
      expect(data.data.url).toMatch(/^https?:\/\//)
    })
  })
})
