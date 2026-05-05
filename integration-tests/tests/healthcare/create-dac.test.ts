/**
 * create-dac — Phase D of the DAC pipeline. Pure CRUD: list, create,
 * read, update. No execution / runtime exercise — that's run-dac (Phase E).
 *
 * Mirrors playwright-e2e/tests/data-activation-clients.spec.ts §1–§3 (the
 * UI flow does §4 upload + §5 logs in the same file; we split those into
 * run-dac.test.ts).
 *
 * State files this spec touches:
 *   READS:  base.state.json                           (dacName)
 *   READS:  <runId>/bootstrap.state.json              REQUIRED
 *   READS:  <runId>/data-sources.state.json           REQUIRED — dataSourceId
 *   READS:  <runId>/tools.state.json                  REQUIRED — manualUploadToolId
 *   READS:  <runId>/interoperability-contracts.state.json  REQUIRED — both contract ids
 *   READS:  <runId>/create-dac.state.json             own prior output
 *   WRITES: <runId>/create-dac.state.json             dacId + dacSlug
 */
import { describe, beforeAll, expect, it } from 'vitest'
import type { PlatformApi } from '@alvera-ai/platform-sdk'
import { buildApi } from '../../src/api'
import {
  type BaseState,
  type BootstrapState,
  type CreateDacState,
  type CustomDatasetsState,
  type DataSourcesState,
  type Industry,
  type InteropContractsState,
  type ToolsState,
  loadBase,
  loadSpec,
  requireSpec,
  saveSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function emptyCreateDac(): CreateDacState {
  return { dacId: null, dacSlug: null, contactUsDacId: null, contactUsDacSlug: null }
}

describe('healthcare/create-dac', () => {
  let base: BaseState
  let bootstrap: BootstrapState
  let dataSources: DataSourcesState
  let tools: ToolsState
  let interop: InteropContractsState
  let customDatasets: CustomDatasetsState
  let s: CreateDacState
  let api: PlatformApi

  beforeAll(() => {
    base = loadBase(INDUSTRY)
    bootstrap = requireSpec(INDUSTRY, 'bootstrap')
    dataSources = requireSpec(INDUSTRY, 'data-sources')
    tools = requireSpec(INDUSTRY, 'tools')
    interop = requireSpec(INDUSTRY, 'interoperability-contracts')
    customDatasets = requireSpec(INDUSTRY, 'custom-datasets')
    s = loadSpec(INDUSTRY, 'create-dac') ?? emptyCreateDac()

    if (
      !bootstrap.sarahSessionToken ||
      !bootstrap.tenantSlug ||
      !bootstrap.datalakeSlug
    ) {
      throw new Error('bootstrap.state.json incomplete')
    }
    if (!dataSources.dataSourceId) throw new Error('data-sources missing dataSourceId')
    if (!tools.manualUploadToolId) throw new Error('tools missing manualUploadToolId')
    if (!interop.systemContractId || !interop.customContractId) {
      throw new Error('interop-contracts missing one or both contract ids')
    }
    api = buildApi(bootstrap.sarahSessionToken)
  })

  // ─── §1 list DACs — fresh datalake returns paginated envelope ─────────
  it('§1 list DACs returns paginated envelope', async () => {
    const { data } = await api.dataActivationClients.list(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
    )
    expect(Array.isArray(data.data)).toBe(true)
    expect(data.meta).toBeDefined()
  })

  // ─── §2 create the manual-upload DAC, attach both interop contracts ──
  it('§2 create manual-upload DAC with both interop contracts', async (ctx) => {
    if (s.dacId) {
      ctx.skip()
      return
    }

    const { data } = await api.dataActivationClients.create(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      {
        // Required by Platform.OpenApiSchema.DataActivationClientRequest:
        //   name, tool_id, data_source_id, tool_call.
        // slug + datalake_id + tenant_id auto-derived server-side.
        name: base.dacName,
        description: 'CAHPS reconciliation — manual CSV upload to interop contracts',
        tool_id: tools.manualUploadToolId!,
        data_source_id: dataSources.dataSourceId!,
        tool_call: { tool_call_type: 'manual_upload' },
        // interoperability_contract_ids is a virtual array on the schema —
        // the controller wires it up via assoc_interoperability_contracts/1.
        interoperability_contract_ids: [
          interop.systemContractId!,
          interop.customContractId!,
        ],
      },
    )

    expect(data.id).toMatch(UUID_RE)
    expect(data.name).toBe(base.dacName)
    expect(data.slug).toBeTruthy()
    s.dacId = data.id ?? null
    s.dacSlug = data.slug ?? null
    saveSpec(INDUSTRY, 'create-dac', s)
  })

  // ─── §3 GET /data-activation-clients/:slug returns the DAC we created ──
  it('§3 GET DAC by slug returns the created resource', async () => {
    if (!s.dacSlug) throw new Error('§2 must succeed first')

    const { data } = await api.dataActivationClients.get(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      s.dacSlug,
    )
    expect(data.id).toBe(s.dacId)
    expect(data.name).toBe(base.dacName)
    expect(data.slug).toBe(s.dacSlug)
  })

  // ─── §3a GET DAC metadata ───────────────────────────────────────────
  it('§3a GET DAC metadata returns dataset metadata', async () => {
    if (!s.dacSlug) throw new Error('§2 must succeed first')

    const { data } = await api.dataActivationClients.metadata(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      s.dacSlug,
    )
    expect(data).toBeDefined()
  })

  // ─── §4 the DAC appears in the listing ────────────────────────────────
  it('§4 DAC appears in listing', async () => {
    if (!s.dacId) throw new Error('§2 must succeed first')

    const { data } = await api.dataActivationClients.list(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
    )
    const ours = data.data?.find((dac) => dac.id === s.dacId)
    expect(ours).toBeDefined()
    expect(ours?.name).toBe(base.dacName)
  })

  // ─── §5 update DAC description (PUT semantics — full body required) ──
  // The API uses PUT (no PATCH per the platform's REST conventions). We
  // submit the same body as §2 with a tweaked description; everything
  // else round-trips unchanged.
  it('§5 update DAC description', async () => {
    if (!s.dacSlug) throw new Error('§2 must succeed first')

    const updatedDescription = 'CAHPS reconciliation — UPDATED via PUT'

    const { data } = await api.dataActivationClients.update(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      s.dacSlug,
      {
        name: base.dacName,
        description: updatedDescription,
        tool_id: tools.manualUploadToolId!,
        data_source_id: dataSources.dataSourceId!,
        tool_call: { tool_call_type: 'manual_upload' },
        interoperability_contract_ids: [
          interop.systemContractId!,
          interop.customContractId!,
        ],
      },
    )

    expect(data.id).toBe(s.dacId)
    expect(data.description).toBe(updatedDescription)
    expect(data.slug).toBe(s.dacSlug) // slug stays stable across updates
  })

  // ─── §6 create the Contact Us DAC for GT ingestion ──────────────────────
  // Separate DAC dedicated to ingesting submission rows into the Contact Us
  // generic table. Reuses:
  //   * `tools.manualUploadToolId`  (any DAC tool works; manual_upload
  //                                  needs no special wiring)
  //   * `dataSources.dataSourceId`  (DAC must attach to a data_source; the
  //                                  CAHPS Athena one is fine — DAC runtime
  //                                  ignores its body for manual_upload)
  //   * `interop.contactUsContractId` (auto-created identity contract bound
  //                                    to the GT — see interoperability-
  //                                    contracts §7)
  //
  // The agent-driven-workflow spec ingests 3 submissions through this DAC
  // in §N, populating the GT for the workflow run.
  it('§6 create Contact Us GT DAC with identity contract', async (ctx) => {
    if (s.contactUsDacId) {
      ctx.skip()
      return
    }
    if (!customDatasets.contactUsTableId) {
      throw new Error('custom-datasets.state.json missing contactUsTableId')
    }
    if (!interop.contactUsContractId) {
      throw new Error('interoperability-contracts.state.json missing contactUsContractId — run interop first')
    }

    const { data } = await api.dataActivationClients.create(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      {
        name: `${base.dacName} — Contact Us`,
        description: 'Manual-upload DAC for ingesting Contact Us submissions into the GT',
        tool_id: tools.manualUploadToolId!,
        data_source_id: dataSources.dataSourceId!,
        tool_call: { tool_call_type: 'manual_upload' },
        interoperability_contract_ids: [interop.contactUsContractId],
      },
    )

    expect(data.id).toMatch(UUID_RE)
    expect(data.slug).toBeTruthy()
    s.contactUsDacId = data.id ?? null
    s.contactUsDacSlug = data.slug ?? null
    saveSpec(INDUSTRY, 'create-dac', s)
  })
})
