/**
 * data-sources — create the Athena Health EMR data source under the
 * tenant's healthcare datalake.
 *
 * Mirrors playwright-e2e/tests/data-sources.spec.ts §1–§3 (the data-source
 * surface only; the sibling Playwright spec also exercises every tool type
 * — those land in tools.test.ts since they're a separate API resource).
 *
 * State files this spec touches:
 *   READS:  base.state.json                       (dataSourceName)
 *   READS:  <runId>/bootstrap.state.json          REQUIRED — needs sarah's
 *                                                 tenant-scoped bearer +
 *                                                 tenantSlug + datalakeSlug
 *   READS:  <runId>/data-sources.state.json       own prior output (rerun)
 *   WRITES: <runId>/data-sources.state.json       dataSourceId
 */
import { describe, beforeAll, expect, it } from 'vitest'
import type { PlatformApi } from '@alvera-ai/platform-sdk'
import { buildApi } from '../../src/api'
import {
  type BaseState,
  type BootstrapState,
  type DataSourcesState,
  type Industry,
  loadBase,
  loadSpec,
  requireSpec,
  saveSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Mirrors playwright-e2e/tests/data-sources.spec.ts:32-33. Hardcoded values
// here keep the two suites trading the same fixture for the same dev tenant.
const DATA_SOURCE_URI = '12345.athenahealth.com'
const DATA_SOURCE_DESCRIPTION = 'AthenaHealth EHR practice integration'

function emptyDataSources(): DataSourcesState {
  return { dataSourceId: null }
}

describe('healthcare/data-sources', () => {
  let base: BaseState
  let bootstrap: BootstrapState
  let s: DataSourcesState
  let sarahTenantApi: PlatformApi

  beforeAll(() => {
    base = loadBase(INDUSTRY)
    bootstrap = requireSpec(INDUSTRY, 'bootstrap')
    s = loadSpec(INDUSTRY, 'data-sources') ?? emptyDataSources()

    if (
      !bootstrap.sarahSessionToken ||
      !bootstrap.tenantSlug ||
      !bootstrap.datalakeSlug
    ) {
      throw new Error(
        'bootstrap.state.json incomplete — sarahSessionToken / tenantSlug / datalakeSlug missing',
      )
    }
    sarahTenantApi = buildApi(bootstrap.sarahSessionToken)
  })

  // ─── §1 list data sources returns a paginated envelope ────────────────
  // Playwright's equivalent step asserts a seeded "Alvera Manual Upload"
  // default is present, but that default is a side-effect of the LiveView
  // datalake-setup flow — API-created tenants don't get it. So we only
  // assert the listing endpoint responds with a well-formed paginated
  // envelope (even if `data` is empty before §2 creates the Athena source).
  it('§1 list data sources returns paginated envelope', async () => {
    const { data } = await sarahTenantApi.dataSources.list(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
    )
    expect(Array.isArray(data.data)).toBe(true)
    expect(data.meta).toBeDefined()
  })

  // ─── §2 create the Athena Health EMR data source ───────────────────────
  it('§2 create Athena Health EMR data source', async (ctx) => {
    if (s.dataSourceId) {
      ctx.skip()
      return
    }

    const { data } = await sarahTenantApi.dataSources.create(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      {
        // Required by Platform.OpenApiSchema.DataSourceRequest:
        //   name, uri, status, is_default
        // datalake_id is bound from the path slug by the controller.
        name: base.dataSourceName,
        uri: DATA_SOURCE_URI,
        description: DATA_SOURCE_DESCRIPTION,
        status: 'active',
        is_default: false,
      },
    )

    expect(data.id).toMatch(UUID_RE)
    expect(data.name).toBe(base.dataSourceName)
    expect(data.uri).toBe(DATA_SOURCE_URI)
    s.dataSourceId = data.id ?? null
    saveSpec(INDUSTRY, 'data-sources', s)
  })

  // ─── §3 listing now shows the Athena source alongside the default ─────
  it('§3 Athena source appears in listing', async () => {
    if (!s.dataSourceId) throw new Error('§2 must succeed first')

    const { data } = await sarahTenantApi.dataSources.list(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
    )
    const ours = data.data?.find((src) => src.id === s.dataSourceId)
    expect(ours).toBeDefined()
    expect(ours?.name).toBe(base.dataSourceName)
    expect(ours?.uri).toBe(DATA_SOURCE_URI)
  })
})
