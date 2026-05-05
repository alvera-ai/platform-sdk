/**
 * run-dac — Phase E of the DAC pipeline. Exercises the runtime path for
 * the CAHPS contracts:  inline JSON ingest → batch + jobs created → log
 * rows + dataset rows produced.
 *
 * Mirrors the CSV-ingestion describe block in
 *   test/platform/agentic_workflows/appointment_follow_up_sms_workflow_test.exs
 * lines 891-987 (specifically the assertions on lines 938-949: jobs queued,
 * appointments listed with non-null patient_id post-MDM).
 *
 * Verification strategy is two-layered:
 *
 *   1. **DAC log row** — assert `rows_ingested > 0` for both contracts
 *      (patient + appointment) so we know the contract pipeline didn't
 *      silently fail.
 *   2. **Dataset search** — POST /datasets/{patient,appointment}/user-searches
 *      with a SQL where clause that joins regulated_identifiers and pins
 *      both the EMR identifier value AND our batch_id, proving:
 *        - the contract templates rendered the identifier correctly
 *        - the row landed in this specific ingest batch (not stale data)
 *        - MDM resolution populated patient_id (the search query uses
 *          appointment regulated_identifiers, which only get persisted
 *          when the upsert succeeded end-to-end).
 *
 * State files this spec touches:
 *   READS:  <runId>/bootstrap.state.json     REQUIRED
 *   READS:  <runId>/create-dac.state.json    REQUIRED — dacSlug
 *   READS:  <runId>/run-dac-single.state.json       own prior output
 *   WRITES: <runId>/run-dac-single.state.json       lastBatchId
 */
import { describe, beforeAll, expect, it } from 'vitest'
import type { PlatformApi } from '@alvera-ai/platform-sdk'
import { buildApi } from '../../src/api'
import {
  type BootstrapState,
  type CreateDacState,
  type Industry,
  type RunDacSingleState,
  loadSpec,
  requireSpec,
  saveSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// EMR identifiers — randomized PER RUN. The unique-identifier constraint
// at the regulated_identifiers table level can collide with previous runs
// if a static value is reused (server bug we're tracking separately —
// contracts on a single DAC currently race on MDM upsert). Using a fresh
// suffix per run keeps the test deterministic until the race fix lands.
//
// We still hard-code the structure (numeric prefix matching CSV format)
// so the templates render plausible-looking values.
const RUN_SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
const EMR_PATIENT_ID = `7823-${RUN_SUFFIX}`
const EMR_APPOINTMENT_ID = `3047-${RUN_SUFFIX}`

// Single CAHPS-shaped row (parsed from
// test/support/athena/alvera_reviews_cahps_appointments_single.csv with
// `prnt_apptyn = Y` so the parent_appointment_filter passes).
const CAHPS_ROW = {
  appointment_id: EMR_APPOINTMENT_ID,
  parent_appointment_id: EMR_APPOINTMENT_ID,
  appt_date: '3/12/2026',
  prnt_apptyn: 'Y',
  appt_start_time: '2:30 PM',
  appt_slot_duration: '45',
  appt_slot_status: '3 - checked out',
  appt_type: 'Annual wellness visit',
  patient_id: EMR_PATIENT_ID,
  enterprise_id: EMR_PATIENT_ID,
  patient_name: 'Rivera Elena',
  patientdob: '7/22/1950',
  patient_mobile_no: '555-943-2718',
  patient_risk_level: 'medium',
  svc_department: 'EASTSIDE',
  rndrng_provider_id: '602',
  rndrng_provider: 'Dr. Thomas Nguyen',
  source_uri: 'athenahealth.com:vitest-clinic',
}

function emptyRunDac(): RunDacSingleState {
  return { lastBatchId: null }
}

describe('healthcare/run-dac', () => {
  let bootstrap: BootstrapState
  let createDac: CreateDacState
  let s: RunDacSingleState
  let api: PlatformApi

  beforeAll(() => {
    bootstrap = requireSpec(INDUSTRY, 'bootstrap')
    createDac = requireSpec(INDUSTRY, 'create-dac')
    s = loadSpec(INDUSTRY, 'run-dac-single') ?? emptyRunDac()

    if (!bootstrap.sarahSessionToken || !bootstrap.tenantSlug || !bootstrap.datalakeSlug) {
      throw new Error('bootstrap.state.json incomplete')
    }
    if (!createDac.dacSlug) throw new Error('create-dac.state.json incomplete — dacSlug missing')
    api = buildApi(bootstrap.sarahSessionToken)
  })

  // ─── §1 list logs — pre-ingest, returns paginated envelope ────────────
  it('§1 list logs returns paginated envelope', async () => {
    const { data } = await api.dataActivationClients.logs.list(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      createDac.dacSlug!,
    )
    expect(Array.isArray(data.data)).toBe(true)
    expect(data.meta).toBeDefined()
  })

  // ─── §2 ingest the CAHPS row as inline JSON ───────────────────────────
  // POST /tenants/:slug/datalakes/:slug/data-activation-clients/:slug/ingest
  // with `{ data: <one CSV-shaped row as JSON> }`. The DAC fans the row out
  // through both contracts (patient + appointment); each produces its own
  // log row + dataset upsert.
  it('§2 ingest a CAHPS-shaped JSON row', async () => {
    const { data } = await api.dataActivationClients.ingest(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      createDac.dacSlug!,
      { data: CAHPS_ROW },
    )

    expect(data.batch_id).toMatch(UUID_RE)
    expect(typeof data.key).toBe('string')
    expect(data.key).toBeTruthy()
    expect(typeof data.jobs_count).toBe('number')
    expect(data.jobs_count).toBeGreaterThan(0)
    s.lastBatchId = data.batch_id ?? null
    saveSpec(INDUSTRY, 'run-dac-single', s)
  })

  // ─── §3 every top-level contract produces a merged log row ───────────
  // Two assertions, both polled up to 60s:
  //   (a) Each top-level contract (Patient + Appointment) logs a row with
  //       `rows_ingested > 0`. Cascade rows (locations, related_persons)
  //       are written by the appointment template's nested upserts and
  //       carry `rows_ingested = 0` — they're filtered out before the
  //       count check.
  //   (b) Each of those rows has merged ndjson URIs in `output_files`.
  //       This proves the inline `BatchCompletionHandler.batch_exhausted/1`
  //       call (added in `ingest_json_sync/2`) successfully kicked off the
  //       per-dataset_table `BatchMergeWorker` jobs and they committed
  //       before the deadline. Without the inline call, output_files
  //       would stay empty and the data would never reach the canonical
  //       merged ndjson archives.
  it('§3 every contract produces a merged log row', { timeout: 90_000 }, async () => {
    if (!s.lastBatchId) throw new Error('§2 must succeed first')

    const EXPECTED_LOG_ROWS = 2
    const deadline = Date.now() + 60_000
    let ourRows: Array<Record<string, unknown>> = []
    let ingestingRows: Array<Record<string, unknown>> = []
    let allGreen = false
    while (Date.now() < deadline && !allGreen) {
      const { data } = await api.dataActivationClients.logs.list(
        bootstrap.tenantSlug!,
        bootstrap.datalakeSlug!,
        createDac.dacSlug!,
      )
      ourRows = (data.data ?? [])
        .map((row) => row as Record<string, unknown>)
        .filter((r) => r.batch_id === s.lastBatchId)
      ingestingRows = ourRows.filter(
        (r) => typeof r.rows_ingested === 'number' && r.rows_ingested > 0,
      )
      const allMerged = ingestingRows.every(
        (r) => Array.isArray(r.output_files) && (r.output_files as unknown[]).length > 0,
      )
      allGreen = ingestingRows.length >= EXPECTED_LOG_ROWS && allMerged
      if (!allGreen) await new Promise((r) => setTimeout(r, 1_000))
    }

    if (!allGreen) {
      const summary = ourRows.map((r) => ({
        dataset_table: r.dataset_table,
        rows_ingested: r.rows_ingested,
        dataset_updated: r.dataset_updated,
        output_files_count: Array.isArray(r.output_files)
          ? (r.output_files as unknown[]).length
          : 0,
      }))
      throw new Error(
        `expected ${EXPECTED_LOG_ROWS} top-level log rows with rows_ingested > 0 AND merged output_files for batch ${s.lastBatchId} within 60s — saw ${ourRows.length} total / ${ingestingRows.length} ingesting: ${JSON.stringify(summary)}`,
      )
    }

    console.log(`[run-dac §3] batch_id=${s.lastBatchId}:`)
    for (const row of ourRows) {
      const merged = Array.isArray(row.output_files) ? (row.output_files as unknown[]).length : 0
      console.log(
        `  • dataset_table=${row.dataset_table} rows_ingested=${row.rows_ingested} dataset_updated=${row.dataset_updated} merged_files=${merged}`,
      )
    }
  })

  // ─── §3a logs.get — fetch a specific DAC log entry by id ──────────────
  it('§3a logs.get returns a specific log entry', { timeout: 90_000 }, async () => {
    if (!s.lastBatchId) throw new Error('§2 must succeed first')

    const deadline = Date.now() + 60_000
    let logId: string | null = null
    while (Date.now() < deadline && !logId) {
      const { data } = await api.dataActivationClients.logs.list(
        bootstrap.tenantSlug!,
        bootstrap.datalakeSlug!,
        createDac.dacSlug!,
      )
      const ourRow = (data.data ?? [])
        .map((row) => row as Record<string, unknown>)
        .find((r) => r.batch_id === s.lastBatchId)
      if (ourRow?.id) {
        logId = ourRow.id as string
        break
      }
      await new Promise((r) => setTimeout(r, 1_000))
    }
    if (!logId) throw new Error(`no log row found for batch ${s.lastBatchId}`)

    const { data: logEntry } = await api.dataActivationClients.logs.get(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      createDac.dacSlug!,
      logId,
    )
    expect((logEntry as Record<string, unknown>).id).toBe(logId)
    expect((logEntry as Record<string, unknown>).batch_id).toBe(s.lastBatchId)
  })

  // ─── §3b runManually — trigger a manual DAC run ──────────────────────
  it('§3b runManually triggers a DAC execution', async () => {
    const { data } = await api.dataActivationClients.runManually(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      createDac.dacSlug!,
    )
    expect(data).toBeDefined()
  })

  // ─── §4 patient row reachable via two-step search (POST → GET) ─────────
  // Two-step claims pattern:
  //   (1) POST /datasets/patient/user-searches with a WHERE clause that
  //       pins ri.value=EMR_PATIENT_ID + rp.batch_id=lastBatchId. This
  //       materialises matching IDs into search_results (status=completed
  //       on success). `results_count` on the POST response is always
  //       null — the actual rows live in `search_results` and only become
  //       visible via the paginated GET below.
  //   (2) GET /datasets/patient/search?user_search_id=<id>&data_access_mode=unregulated
  //       — paginates rows from search_results, hydrating from the
  //       *unregulated* schema so PHI fields come back as
  //       { redacted_data, token, type } objects. Asserts both:
  //         • plain field → `id` is a primitive UUID string, and
  //           `gender` is a primitive enum string ("female"|"male"|...).
  //         • tokenized field → `birth_date` is an object with shape
  //           `{ redacted_data, token, type }` (per
  //           Platform.Extensions.Ecto.TokenizedDataType serialisation).
  //
  // This is the MDM-resolution proof for the patient: the row only
  // appears in the unregulated schema if `Patient.cast_tokenized_data`
  // ran end-to-end on `birth_date` during the upsert path.
  it('§4 patient — POST→GET unregulated read returns tokenized birth_date + plain gender', { timeout: 60_000 }, async () => {
    if (!s.lastBatchId) throw new Error('§2 must succeed first')

    // (1) POST creates the UserSearch and runs the SQL synchronously.
    //     `rp` = regulated_patients (the dataset's base alias — see
    //     Patients.get_base_decomposed_query). Both rp and ri carry a
    //     `batch_id` column via `tracking_fields()`, so the prefix is
    //     required to disambiguate.
    const { data: userSearch } = await api.datasets.createUserSearch(
      'patient',
      {
        search_query: `ri.value = '${EMR_PATIENT_ID}' AND rp.batch_id = '${s.lastBatchId}'`,
      },
      { datalakeId: undefined },
    )

    if (userSearch.status !== 'completed') {
      throw new Error(
        `patient user-search status=${userSearch.status} error_message=${userSearch.error_message ?? '(none)'}`,
      )
    }
    if (!userSearch.id) throw new Error('user_search.id missing on POST response')

    // (2) Poll-GET. `BatchMergeWorker` runs async (Oban :smart engine,
    //     not :inline), so a fresh DAC may take a few seconds to land
    //     rows in the unregulated schema. 30s budget covers the tail.
    const deadline = Date.now() + 30_000
    let rows: Array<Record<string, unknown>> = []
    while (Date.now() < deadline && rows.length === 0) {
      const { data } = await api.datasets.search('patient', {
        userSearchId: userSearch.id,
        dataAccessMode: 'unregulated',
      })
      rows = (data.data ?? []) as Array<Record<string, unknown>>
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 1_000))
    }

    expect(
      rows.length,
      `expected at least one patient row from unregulated GET within 30s for user_search_id=${userSearch.id}`,
    ).toBeGreaterThanOrEqual(1)

    const patient = rows[0]!
    expect(typeof patient.id, 'patient.id should be a plain UUID string').toBe('string')
    expect(patient.id as string).toMatch(UUID_RE)
    expect(typeof patient.gender, 'patient.gender should be a plain enum string').toBe('string')

    // birth_date is a TokenizedDataType field on Patient — under the
    // unregulated read it round-trips as { redacted_data, token, type }.
    expect(patient.birth_date, 'patient.birth_date should be present (tokenized object)').toBeDefined()
    expect(typeof patient.birth_date).toBe('object')
    const birthDate = patient.birth_date as Record<string, unknown>
    expect(birthDate, 'patient.birth_date should expose redacted_data').toHaveProperty('redacted_data')
    expect(birthDate, 'patient.birth_date should expose token').toHaveProperty('token')
    expect(birthDate, 'patient.birth_date should expose type').toHaveProperty('type')
    expect(birthDate.type, 'patient.birth_date.type should be "date"').toBe('date')
  })

  // ─── §5 appointment row reachable via two-step search (POST → GET) ────
  // Same two-step shape as §4 but for the appointment dataset. Per
  // appointments.ex, the base_decomposed_query joins
  // `regulated_identifiers ri ON ri.owner_id = ra.id AND ri.owner_type =
  // 'regulated_appointment'`, so `ri.value = EMR_APPOINTMENT_ID` filters
  // to this batch's appointment. The unregulated GET surfaces:
  //   • plain field → `start` is a plain UTC datetime string (ISO 8601),
  //     `id` is a plain UUID string.
  //   • tokenized field → `description` is `{ redacted_data, token, type }`
  //     (the CAHPS row's appt_type='Annual wellness visit' is the source).
  //
  // Critically: the appointment row only persists after MDM resolves
  // the patient AND the appointment upsert succeeds — both gated. If
  // MDM lost the unique-identifier race, the appointment never persists
  // and the GET returns []. The `run_ingest_sync/2` retry recursion
  // absorbs that race; the poll covers the async-merge tail.
  it('§5 appointment — POST→GET unregulated read returns tokenized description + plain start', { timeout: 60_000 }, async () => {
    if (!s.lastBatchId) throw new Error('§2 must succeed first')

    // (1) POST. `ra` = regulated_appointments. Both ra and rp carry
    //     batch_id, so the prefix disambiguates.
    const { data: userSearch } = await api.datasets.createUserSearch(
      'appointment',
      {
        search_query: `ri.value = '${EMR_APPOINTMENT_ID}' AND ra.batch_id = '${s.lastBatchId}'`,
      },
      { datalakeId: undefined },
    )

    if (userSearch.status !== 'completed') {
      throw new Error(
        `appointment user-search status=${userSearch.status} error_message=${userSearch.error_message ?? '(none)'}`,
      )
    }
    if (!userSearch.id) throw new Error('user_search.id missing on POST response')

    // (2) Poll-GET, same async-merge rationale as §4.
    const deadline = Date.now() + 30_000
    let rows: Array<Record<string, unknown>> = []
    while (Date.now() < deadline && rows.length === 0) {
      const { data } = await api.datasets.search('appointment', {
        userSearchId: userSearch.id,
        dataAccessMode: 'unregulated',
      })
      rows = (data.data ?? []) as Array<Record<string, unknown>>
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 1_000))
    }

    expect(
      rows.length,
      `expected at least one appointment row from unregulated GET within 30s for user_search_id=${userSearch.id}`,
    ).toBeGreaterThanOrEqual(1)

    const appointment = rows[0]!
    expect(typeof appointment.id, 'appointment.id should be a plain UUID string').toBe('string')
    expect(appointment.id as string).toMatch(UUID_RE)
    // `start` is `:utc_datetime` on the appointment schema — plain ISO
    // string round-trips through JSON unchanged.
    expect(typeof appointment.start, 'appointment.start should be a plain ISO datetime string').toBe('string')
    expect(appointment.start as string).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // `description` is a TokenizedDataType field — the CAHPS row's
    // `appt_type` ('Annual wellness visit') is the source value the
    // tokenizer redacted/replaced.
    expect(
      appointment.description,
      'appointment.description should be present (tokenized object)',
    ).toBeDefined()
    expect(typeof appointment.description).toBe('object')
    const description = appointment.description as Record<string, unknown>
    expect(description, 'appointment.description should expose redacted_data').toHaveProperty(
      'redacted_data',
    )
    expect(description, 'appointment.description should expose token').toHaveProperty('token')
    expect(description, 'appointment.description should expose type').toHaveProperty('type')
    expect(description.type, 'appointment.description.type should be "text"').toBe('text')
  })
})
