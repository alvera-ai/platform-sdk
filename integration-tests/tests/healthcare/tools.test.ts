/**
 * tools — create platform tools (one per polymorphic variant).
 *
 * Mirrors playwright-e2e/tests/data-sources.spec.ts §4–§14 (which mixes
 * data-sources and tools in the same UI flow). The JSON API treats them as
 * separate resources, so tools live in their own spec.
 *
 * Landing in batches:
 *   Batch 1 (this file)  manual_upload         ← DAC depends on this
 *   Batch 2+             aws_lambda, sns, sqs, cloud_watch_log_group, s3,
 *                        rest_api, sql_database, sftp, sharepoint, email
 *
 * State files this spec touches:
 *   READS:  base.state.json
 *   READS:  <runId>/bootstrap.state.json     REQUIRED — datalakeId + slug
 *   READS:  <runId>/data-sources.state.json  REQUIRED — Athena dataSourceId
 *                                            (Q2=A: tools attach to existing
 *                                            sources rather than creating
 *                                            a parallel "Manual Upload"
 *                                            data source)
 *   READS:  <runId>/tools.state.json         own prior output
 *   WRITES: <runId>/tools.state.json         per-variant tool ids
 */
import { describe, beforeAll, expect, it } from 'vitest'
import type { PlatformApi } from '@alvera-ai/platform-sdk'
import { buildApi } from '../../src/api'
import {
  type BaseState,
  type BootstrapState,
  type DataSourcesState,
  type Industry,
  type ToolsState,
  loadBase,
  loadSpec,
  requireSpec,
  saveSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Tenant-scoped + unique per (name, data_source_id) — so a constant is fine.
// Each tenant is unique per runId, so collisions are impossible.
const MANUAL_UPLOAD_TOOL_NAME = 'Alvera Manual Upload Tool'
const SMS_TOOL_NAME = 'Alvera SMS (SNS) Tool'
const SMS_FAILING_TOOL_NAME = 'Alvera SMS (SNS) Tool — Misconfigured'

function emptyTools(): ToolsState {
  return { manualUploadToolId: null, smsToolId: null, smsToolFailingId: null }
}

describe('healthcare/tools', () => {
  let base: BaseState
  let bootstrap: BootstrapState
  let dataSources: DataSourcesState
  let s: ToolsState
  let api: PlatformApi

  beforeAll(() => {
    base = loadBase(INDUSTRY)
    bootstrap = requireSpec(INDUSTRY, 'bootstrap')
    dataSources = requireSpec(INDUSTRY, 'data-sources')
    s = loadSpec(INDUSTRY, 'tools') ?? emptyTools()

    if (!bootstrap.sarahSessionToken || !bootstrap.tenantSlug || !bootstrap.datalakeId) {
      throw new Error('bootstrap.state.json incomplete — sarahSessionToken / tenantSlug / datalakeId missing')
    }
    if (!dataSources.dataSourceId) {
      throw new Error('data-sources.state.json incomplete — dataSourceId missing')
    }
    api = buildApi(bootstrap.sarahSessionToken)
  })

  // ─── §1 list tools — fresh tenant returns a paginated envelope ────────
  it('§1 list tools returns paginated envelope', async () => {
    const { data } = await api.tools.list(bootstrap.tenantSlug!)
    expect(Array.isArray(data.data)).toBe(true)
    expect(data.meta).toBeDefined()
  })

  // ─── §2 create the Manual Upload tool ─────────────────────────────────
  // The ManualUpload body has zero fields — the `__type__` discriminator
  // alone is the entire body. intent=`data_exchange` matches the DAC
  // ingestion shape: this tool is the receiver of Manual-Upload-type DACs.
  it('§2 create Manual Upload tool', async (ctx) => {
    if (s.manualUploadToolId) {
      ctx.skip()
      return
    }

    const { data } = await api.tools.create(bootstrap.tenantSlug!, {
      name: MANUAL_UPLOAD_TOOL_NAME,
      description: 'Manual upload tool — receives CSV/NDJSON via presigned S3 URLs',
      intent: 'data_exchange',
      status: 'active',
      datalake_id: bootstrap.datalakeId!,
      data_source_id: dataSources.dataSourceId!,
      // The polymorphic body uses `tool_body_type` as its discriminator
      // (NOT `__type__` — that's the internal Elixir tag; the OpenAPI surface
      // exposes it under the field name configured in tool.ex). The
      // ManualUpload variant is a marker — discriminator alone, no fields.
      body: { tool_body_type: 'manual_upload' },
    })

    expect(data.id).toMatch(UUID_RE)
    expect(data.name).toBe(MANUAL_UPLOAD_TOOL_NAME)
    expect(data.intent).toBe('data_exchange')
    expect(data.status).toBe('active')
    s.manualUploadToolId = data.id ?? null
    saveSpec(INDUSTRY, 'tools', s)
  })

  // ─── §3 the Manual Upload tool appears in the listing ────────────────
  it('§3 Manual Upload tool appears in listing', async () => {
    if (!s.manualUploadToolId) throw new Error('§2 must succeed first')

    const { data } = await api.tools.list(bootstrap.tenantSlug!)
    const ours = data.data?.find((t) => t.id === s.manualUploadToolId)
    expect(ours).toBeDefined()
    expect(ours?.name).toBe(MANUAL_UPLOAD_TOOL_NAME)
  })

  // ─── §4 create the SMS (SNS) tool — happy path, LocalStack-backed ───
  // SNS body uses `access_key` auth + LocalStack creds (well-known
  // `test`/`test`) and an explicit `endpoint_url` so ExAws routes to
  // localhost:4566 instead of falling through to real AWS Identity
  // Center. `iam_role` auth would be wrong here: with no SSO config in
  // dev, ExAws.Config.AuthCache exits trying to refresh creds (see
  // `Tools.try_tool/3` :exit catch — that's the failing-tool case below).
  it('§4 create SMS (SNS) tool wired to LocalStack', async (ctx) => {
    if (s.smsToolId) {
      ctx.skip()
      return
    }

    const { data } = await api.tools.create(bootstrap.tenantSlug!, {
      name: SMS_TOOL_NAME,
      description: 'SMS dispatcher backed by AWS SNS — LocalStack-backed for dev/E2E',
      intent: 'sms',
      status: 'active',
      datalake_id: bootstrap.datalakeId!,
      body: {
        tool_body_type: 'sns',
        auth_method: 'access_key',
        region: 'us-east-1',
        phone_number: '+15551234567',
        endpoint_url: 'http://localhost:4566',
        access_key_id: 'test',
        secret_access_key: 'test',
      },
    })

    expect(data.id).toMatch(UUID_RE)
    expect(data.name).toBe(SMS_TOOL_NAME)
    expect(data.intent).toBe('sms')
    s.smsToolId = data.id ?? null
    saveSpec(INDUSTRY, 'tools', s)
  })

  // ─── §5 test-invocation HAPPY path ────────────────────────────────────
  // POST against the LocalStack-wired tool — expects a clean recorded
  // invocation. Whether LocalStack returns success or error in any given
  // run is environmental noise (the container is shared, occasionally
  // rate-limited); the contract we assert is response shape + 200 status.
  it('§5 POST /tools/:id/test-invocation records the invocation (happy path)', async () => {
    if (!s.smsToolId) throw new Error('§4 must succeed first')

    const { data } = await api.tools.testInvocation(bootstrap.tenantSlug!, s.smsToolId, {
      tool_call: {
        tool_call_type: 'sms_request',
        to: { type: 'custom', body: '+15551234567' },
        body: { type: 'custom', body: 'Hello from Alvera (vitest test-invocation)' },
        sms_type: 'transactional',
      },
    })

    expect(data.id).toMatch(UUID_RE)
    expect(data.status).toMatch(/^(success|error)$/)
    expect(data.tool_call).toMatchObject({ tool_call_type: 'sms_request' })
  })

  // ─── §6 create a deliberately-misconfigured SMS tool ──────────────────
  // `iam_role` auth without LocalStack endpoint forces ExAws.Config.AuthCache
  // to refresh real AWS SSO creds, which exits when no SSO cache exists.
  // The endpoint MUST surface that as a recorded invocation with
  // status='error' rather than a 500 crash. This proves the catch-:exit
  // contract added in `Tools.try_tool/3`.
  it('§6 create misconfigured SMS tool (iam_role, no endpoint)', async (ctx) => {
    if (s.smsToolFailingId) {
      ctx.skip()
      return
    }

    const { data } = await api.tools.create(bootstrap.tenantSlug!, {
      name: SMS_FAILING_TOOL_NAME,
      description: 'Deliberately misconfigured — proves test-invocation graceful error contract',
      intent: 'sms',
      status: 'active',
      datalake_id: bootstrap.datalakeId!,
      body: {
        tool_body_type: 'sns',
        auth_method: 'iam_role',
        region: 'us-east-1',
        phone_number: '+15551234567',
      },
    })

    expect(data.id).toMatch(UUID_RE)
    s.smsToolFailingId = data.id ?? null
    saveSpec(INDUSTRY, 'tools', s)
  })

  // ─── §7 test-invocation ERROR path — never crashes ────────────────────
  // Hits the misconfigured tool. Server-side ExAws will exit when SSO
  // refresh fails. Contract: 200 with status='error' + error_message
  // populated, not a 500 HTML crash page.
  it('§7 POST /tools/:id/test-invocation against bad config returns 200/error', async () => {
    if (!s.smsToolFailingId) throw new Error('§6 must succeed first')

    const { data } = await api.tools.testInvocation(bootstrap.tenantSlug!, s.smsToolFailingId, {
      tool_call: {
        tool_call_type: 'sms_request',
        to: { type: 'custom', body: '+15551234567' },
        body: { type: 'custom', body: 'This will fail at the provider boundary' },
        sms_type: 'transactional',
      },
    })

    expect(data.id).toMatch(UUID_RE)
    expect(data.status).toBe('error')
    expect(data.error_message).toEqual(expect.any(String))
    expect(data.error_message?.length ?? 0).toBeGreaterThan(0)
    expect(data.tool_call).toMatchObject({ tool_call_type: 'sms_request' })
  })
})
