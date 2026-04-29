/**
 * interoperability-contracts — create the two CAHPS contracts (Patient +
 * Appointment) as CUSTOM contracts with template bodies inlined from disk.
 *
 * Mirrors the contract setup in
 *   test/platform/agentic_workflows/appointment_follow_up_sms_workflow_test.exs
 * (the "full E2E: CSV ingestion → event → Review SMS workflow" describe block,
 * lines 891-987). That Elixir test does:
 *
 *   appointment_template =
 *     insert(:interoperability_contract, %{
 *       type: :custom,
 *       resource_type: "appointment",
 *       body: File.read!(@appointment_template_path),
 *       mdm_input_template_type: :custom,
 *       mdm_input_template: File.read!(@mdm_template_path),
 *       filter_template: @parent_appointment_filter
 *     })
 *
 *   patient_template =
 *     insert(:interoperability_contract, %{
 *       type: :custom,
 *       resource_type: "patient",
 *       body: File.read!(@patient_template_path),
 *       filter_template: @parent_appointment_filter
 *     })
 *
 * Vitest equivalent: read the same .liquid files via Node fs and pass the
 * contents as `template_config.body` / `mdm_input_config.body`. NO blueprint
 * sync needed — these are user-created custom contracts pointing at local
 * template files.
 *
 * State files this spec touches:
 *   READS:  base.state.json                                (interopTemplateName)
 *   READS:  <runId>/bootstrap.state.json                   REQUIRED
 *   READS:  <runId>/interoperability-contracts.state.json  own prior output
 *   WRITES: <runId>/interoperability-contracts.state.json  {patient,appointment}{Id,Slug}
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, beforeAll, expect, it } from 'vitest'
import type { PlatformApi } from '@alvera-ai/platform-sdk'
import { buildApi } from '../../src/api'
import {
  type BootstrapState,
  type CustomDatasetsState,
  type Industry,
  type InteropContractsState,
  loadSpec,
  requireSpec,
  saveSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Mirrors @parent_appointment_filter from the Elixir test (line 33). Skips
// any row where prnt_apptyn = 'Y' / 'y' (those are parent appointment rows
// that the CAHPS pipeline ignores in favour of their child rows).
const PARENT_APPOINTMENT_FILTER =
  "{% unless msg.row.prnt_apptyn == 'Y' or msg.row.prnt_apptyn == 'y' %}true{% endunless %}"

// Template files live as test fixtures inside integration-tests/. They were
// originally hot-linked from `platform/priv/liquid_templates/...` when this
// suite lived in the platform repo; after the move to platform-sdk we vendor
// them as fixtures so the suite is self-contained and has no cross-repo
// filesystem dependency. The test asserts platform sandbox-run behaviour
// given THESE specific template inputs — the templates are test inputs the
// suite owns, not a contract on the platform's stock templates.
const TEMPLATE_ROOT = path.resolve(__dirname, 'fixtures/templates')
const PATIENT_TEMPLATE_BODY = fs.readFileSync(
  path.join(TEMPLATE_ROOT, '_cahps_appointments_healthcare_patient.liquid'),
  'utf8',
)
const APPOINTMENT_TEMPLATE_BODY = fs.readFileSync(
  path.join(TEMPLATE_ROOT, '_cahps_appointments_healthcare_appointment.liquid'),
  'utf8',
)
const MDM_TEMPLATE_BODY = fs.readFileSync(
  path.join(TEMPLATE_ROOT, '_cahps_appointments_healthcare_mdm.liquid'),
  'utf8',
)

// Contract names match the blueprint-seeded ones used by the Playwright DAC
// spec (so the same `interop` records would be interchangeable). Names are
// only fixture identifiers — not load-bearing on the pipeline.
const PATIENT_CONTRACT_NAME = 'CAHPS Appointments — Patient'
const APPOINTMENT_CONTRACT_NAME = 'CAHPS Appointments — Appointment'

// Realistic CAHPS CSV row (parsed from
// test/support/athena/alvera_reviews_cahps_appointments_single.csv). Used by
// the §5/§6 sandbox-run tests so each contract is proven to render against
// CSV-shaped input BEFORE the run-dac spec ingests live.
const CAHPS_ROW = {
  appointment_id: '3047',
  parent_appointment_id: '3047',
  appt_date: '3/12/2026',
  // 'Y' marks this as the parent (canonical) appointment row. The
  // filter_template (PARENT_APPOINTMENT_FILTER) skips any row where
  // prnt_apptyn != 'Y' — keeping only parent rows in the pipeline. The
  // semantics are inverted from naive reading: "rendering empty = pass".
  prnt_apptyn: 'Y',
  appt_start_time: '2:30 PM',
  appt_slot_duration: '45',
  appt_slot_status: '3 - checked out',
  appt_type: 'Annual wellness visit',
  patient_id: '7823',
  enterprise_id: '7823',
  patient_name: 'Rivera Elena',
  patientdob: '7/22/1950',
  patient_mobile_no: '555-943-2718',
  patient_risk_level: 'medium',
  svc_department: 'EASTSIDE',
  rndrng_provider_id: '602',
  rndrng_provider: 'Dr. Thomas Nguyen',
  source_uri: 'athenahealth.com:vitest-clinic',
}

function emptyContracts(): InteropContractsState {
  return {
    systemContractId: null,
    systemContractSlug: null,
    customContractId: null,
    customContractSlug: null,
    contactUsContractId: null,
    contactUsContractSlug: null,
  }
}

describe('healthcare/interoperability-contracts', () => {
  let bootstrap: BootstrapState
  let customDatasets: CustomDatasetsState
  let s: InteropContractsState
  let api: PlatformApi

  beforeAll(() => {
    bootstrap = requireSpec(INDUSTRY, 'bootstrap')
    customDatasets = requireSpec(INDUSTRY, 'custom-datasets')
    s = loadSpec(INDUSTRY, 'interoperability-contracts') ?? emptyContracts()

    if (
      !bootstrap.sarahSessionToken ||
      !bootstrap.tenantSlug ||
      !bootstrap.datalakeSlug
    ) {
      throw new Error(
        'bootstrap.state.json incomplete — sarahSessionToken / tenantSlug / datalakeSlug missing',
      )
    }
    api = buildApi(bootstrap.sarahSessionToken)
  })

  // ─── §1 list contracts — fresh tenant returns a well-formed envelope ──
  it('§1 list contracts returns paginated envelope', async () => {
    const { data } = await api.interoperabilityContracts.list(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
    )
    expect(Array.isArray(data.data)).toBe(true)
    expect(data.meta).toBeDefined()
  })

  // ─── §2 create the CAHPS Patient contract (custom, inlined templates) ─
  // State key reuse: `systemContractId/Slug` historically meant "the patient
  // contract" — keeping the names as-is so downstream specs (create-dac,
  // run-dac) don't need to change. The `system` in the name refers to its
  // role (the patient resource), not to the contract `type` (now :custom).
  it('§2 create CAHPS Patient contract', async (ctx) => {
    if (s.systemContractId) {
      ctx.skip()
      return
    }

    const { data } = await api.interoperabilityContracts.create(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      {
        name: PATIENT_CONTRACT_NAME,
        description: 'CAHPS appointments → FHIR R4 Patient (custom template)',
        resource_type: 'patient',
        filter_template: PARENT_APPOINTMENT_FILTER,
        template_config: { type: 'custom', body: PATIENT_TEMPLATE_BODY },
        mdm_input_config: { type: 'custom', body: MDM_TEMPLATE_BODY },
        generic_table_id: null,
      },
    )

    expect(data.id).toMatch(UUID_RE)
    expect(data.name).toBe(PATIENT_CONTRACT_NAME)
    expect(data.resource_type).toBe('patient')
    expect(data.slug).toBeTruthy()
    s.systemContractId = data.id ?? null
    s.systemContractSlug = data.slug ?? null
    saveSpec(INDUSTRY, 'interoperability-contracts', s)
  })

  // ─── §3 create the CAHPS Appointment contract (custom, inlined) ───────
  it('§3 create CAHPS Appointment contract', async (ctx) => {
    if (s.customContractId) {
      ctx.skip()
      return
    }

    const { data } = await api.interoperabilityContracts.create(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      {
        name: APPOINTMENT_CONTRACT_NAME,
        description: 'CAHPS appointments → FHIR R4 Appointment (custom template)',
        resource_type: 'appointment',
        filter_template: PARENT_APPOINTMENT_FILTER,
        template_config: { type: 'custom', body: APPOINTMENT_TEMPLATE_BODY },
        // Appointment contract also needs MDM input so the upsert path can
        // populate `patient_id` from the resolved patient — same pattern as
        // the Elixir test (line 905, mdm_input_template: read mdm template).
        mdm_input_config: { type: 'custom', body: MDM_TEMPLATE_BODY },
        generic_table_id: null,
      },
    )

    expect(data.id).toMatch(UUID_RE)
    expect(data.name).toBe(APPOINTMENT_CONTRACT_NAME)
    expect(data.resource_type).toBe('appointment')
    s.customContractId = data.id ?? null
    s.customContractSlug = data.slug ?? null
    saveSpec(INDUSTRY, 'interoperability-contracts', s)
  })

  // ─── §4 both contracts appear in the listing ──────────────────────────
  it('§4 both contracts visible in listing', async () => {
    if (!s.systemContractId || !s.customContractId) {
      throw new Error('§2 and §3 must succeed first')
    }

    const { data } = await api.interoperabilityContracts.list(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
    )
    const ids = data.data?.map((c) => c.id) ?? []
    expect(ids).toContain(s.systemContractId)
    expect(ids).toContain(s.customContractId)

    const patient = data.data?.find((c) => c.id === s.systemContractId)
    expect(patient?.name).toBe(PATIENT_CONTRACT_NAME)
    expect(patient?.resource_type).toBe('patient')

    const appt = data.data?.find((c) => c.id === s.customContractId)
    expect(appt?.name).toBe(APPOINTMENT_CONTRACT_NAME)
    expect(appt?.resource_type).toBe('appointment')
  })

  // ─── §5 sandbox-run patient contract against a CAHPS-shaped row ───────
  // Proves the patient template renders correctly against CSV-shaped input.
  // If §5 fails, the run-dac spec will silently produce empty patient rows.
  it('§5 sandbox-run patient contract with CAHPS row', async () => {
    if (!s.systemContractSlug) throw new Error('§2 must succeed first')

    const { data } = await api.interoperabilityContracts.run(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      s.systemContractSlug,
      CAHPS_ROW,
    )

    expect(data.stage).toBe('completed')
    expect(data.filter_result).toBe('pass')
    expect(data.transformed).toBeDefined()
    expect(data.transformed).not.toBeNull()

    const transformed = (data.transformed ?? {}) as Record<string, unknown>
    // Patient template must render the FHIR R4 identifier with the
    // patient_id from the row (templates use msg.patient_id).
    const identifiers = (transformed.identifier ?? []) as Array<Record<string, unknown>>
    expect(identifiers.length).toBeGreaterThan(0)
    expect(identifiers[0]?.value).toBe('7823')
    expect(transformed.active).toBe(true)
    expect(transformed.source_uri).toBe(CAHPS_ROW.source_uri)
  })

  // ─── §6 sandbox-run appointment contract against the same CAHPS row ───
  it('§6 sandbox-run appointment contract with CAHPS row', async () => {
    if (!s.customContractSlug) throw new Error('§3 must succeed first')

    const { data } = await api.interoperabilityContracts.run(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      s.customContractSlug,
      CAHPS_ROW,
    )

    expect(data.stage).toBe('completed')
    expect(data.filter_result).toBe('pass')
    expect(data.transformed).toBeDefined()
    expect(data.transformed).not.toBeNull()

    const transformed = (data.transformed ?? {}) as Record<string, unknown>
    // appt_slot_status "3 - checked out" maps to FHIR status "fulfilled"
    // per the appointment template (lines 9-10 of the .liquid file).
    expect(transformed.status).toBe('fulfilled')
    // The appointment_id (msg.appointment_id) carries through the identifier
    // — this is the EMR identifier the CAHPS workflow joins on.
    const identifiers = (transformed.identifier ?? []) as Array<Record<string, unknown>>
    expect(identifiers.length).toBeGreaterThan(0)
    expect(identifiers[0]?.value).toBe('3047')
  })

  // ─── §7 pin the auto-created Contact Us GT identity contract ─────────────
  // The GT lifecycle (`Platform.GenericTables.setup_generic_table_interoperability/2`)
  // creates an `template_config: {type: identity}` contract for every GT on
  // insert. So custom-datasets §2 already produced this contract as a side
  // effect — we just need to find it by `generic_table_id` and save the id +
  // slug so downstream specs (create-dac §6, agent-driven-workflow) can bind
  // their DAC to it.
  it('§7 discover Contact Us GT identity contract', async (ctx) => {
    if (s.contactUsContractId) {
      ctx.skip()
      return
    }
    if (!customDatasets.contactUsTableId) {
      throw new Error('custom-datasets.state.json missing contactUsTableId — run custom-datasets first')
    }

    const { data } = await api.interoperabilityContracts.list(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
    )

    // Identity contracts for a GT are uniquely keyed by generic_table_id —
    // there's exactly one per table per datalake (DB-level unique index on
    // `(generic_table_id, type)` for `type = :identity`). Match by that.
    const contract = (data.data ?? []).find(
      (c) =>
        (c as { generic_table_id?: string | null }).generic_table_id ===
        customDatasets.contactUsTableId,
    )

    if (!contract) {
      throw new Error(
        `No interop contract bound to generic_table_id=${customDatasets.contactUsTableId} ` +
          `— GT lifecycle should have auto-created an identity contract; check ` +
          `Platform.GenericTables.setup_generic_table_interoperability/2`,
      )
    }

    expect(contract.id).toMatch(UUID_RE)
    expect(contract.resource_type).toBe('generic_table')
    s.contactUsContractId = contract.id ?? null
    s.contactUsContractSlug = contract.slug ?? null
    saveSpec(INDUSTRY, 'interoperability-contracts', s)
  })
})
