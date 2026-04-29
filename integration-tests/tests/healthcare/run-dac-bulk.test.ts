/**
 * run-dac-bulk — Phase E (bulk variant). Exercises the full-CSV file
 * upload path through the DAC pipeline:
 *
 *   1. POST /datalakes/:slug/upload-link        → { url, key }
 *   2. PUT  <url>  with raw CSV body            → S3 (LocalStack in dev)
 *   3. POST /data-activation-clients/:slug/ingest-file { key }
 *                                               → { job_id, key, status }
 *
 * The bulk path differs from single-row JSON ingest in two important ways:
 *
 *   • Response shape — ingest-file returns ONE Oban job_id (the worker that
 *     reads the file and fans out per-row jobs), NOT a batch_id. The
 *     batch_id is generated server-side inside that worker. So we can't
 *     pin to a specific batch_id from the response.
 *
 *   • Batch-id discovery — we discover OUR batch_id by snapshotting the
 *     DAC log listing BEFORE ingest-file, then polling for new log rows
 *     after. The new rows' batch_id is ours.
 *
 * Once batch_id is known, the dataset-search assertions are identical to
 * run-dac-single (search for any row in the batch with a known EMR
 * identifier value, assert results_count >= 1).
 *
 * Fixture: test/support/athena/alvera_reviews_cahps_appointments_batch1.csv
 *   (3 rows, all parent appointments, all "3 - checked out" → fulfilled)
 *
 * State files this spec touches:
 *   READS:  <runId>/bootstrap.state.json     REQUIRED
 *   READS:  <runId>/create-dac.state.json    REQUIRED — dacSlug
 *   READS:  <runId>/run-dac-bulk.state.json  own prior output
 *   WRITES: <runId>/run-dac-bulk.state.json  uploadKey, ingestJobId,
 *                                            detectedBatchId
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, beforeAll, expect, it } from 'vitest'
import type { PlatformApi } from '@alvera-ai/platform-sdk'
import { buildApi } from '../../src/api'
import {
  type BootstrapState,
  type CreateDacState,
  type Industry,
  type RunDacBulkState,
  loadSpec,
  requireSpec,
  saveSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'

// One identifier value from each row in batch1.csv. The dataset-search
// query in §6/§7 uses these to verify *every* row in the CSV got upserted.
const BATCH1_PATIENT_IDS = ['5001', '5002', '5003']
const BATCH1_APPOINTMENT_IDS = ['1001', '1002', '1003']
const EXPECTED_ROW_COUNT = BATCH1_APPOINTMENT_IDS.length

// CSV vendored as a fixture inside integration-tests/. Originally hot-linked
// from `platform/test/support/athena/...` when this suite lived in the
// platform repo; after the move to platform-sdk we own the fixture so the
// suite is self-contained.
const CSV_PATH = path.resolve(__dirname, 'fixtures/csv/alvera_reviews_cahps_appointments_batch1.csv')

function emptyBulkState(): RunDacBulkState {
  return { uploadKey: null, ingestJobId: null, detectedBatchId: null }
}

describe('healthcare/run-dac-bulk', () => {
  let bootstrap: BootstrapState
  let createDac: CreateDacState
  let s: RunDacBulkState
  let api: PlatformApi
  let csvBody: string

  beforeAll(() => {
    bootstrap = requireSpec(INDUSTRY, 'bootstrap')
    createDac = requireSpec(INDUSTRY, 'create-dac')
    s = loadSpec(INDUSTRY, 'run-dac-bulk') ?? emptyBulkState()

    if (!bootstrap.sarahSessionToken || !bootstrap.tenantSlug || !bootstrap.datalakeSlug) {
      throw new Error('bootstrap.state.json incomplete')
    }
    if (!createDac.dacSlug) throw new Error('create-dac.state.json incomplete — dacSlug missing')
    api = buildApi(bootstrap.sarahSessionToken)
    csvBody = fs.readFileSync(CSV_PATH, 'utf8')
  })

  // ─── §1 create presigned upload link ──────────────────────────────────
  it('§1 create presigned upload link for CSV', async () => {
    const { data } = await api.datalakes.createUploadLink(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      {
        content_type: 'text/csv',
        filename: 'alvera_reviews_cahps_appointments_batch1.csv',
      },
    )
    expect(typeof data.url).toBe('string')
    expect(data.url).toMatch(/^http/)
    expect(typeof data.key).toBe('string')
    expect(data.key).toContain('uploads/')
    s.uploadKey = data.key ?? null
    saveSpec(INDUSTRY, 'run-dac-bulk', s)
    // Stash the URL on the test context — it's a presigned URL with
    // baked-in signature + expiry, so it can't go through state file
    // (next spec session would need to re-presign anyway).
    ;(globalThis as Record<string, unknown>).__bulk_upload_url = data.url
  })

  // ─── §2 PUT the CSV body to the presigned S3 URL ──────────────────────
  // This is a raw S3 PUT against LocalStack (or real S3). The presigned
  // URL has the bucket, key, content-type, expiry and signature baked in.
  // We just pipe the CSV bytes with the matching content-type header.
  it('§2 upload CSV via presigned PUT', async () => {
    const url = (globalThis as Record<string, unknown>).__bulk_upload_url as string | undefined
    if (!url) throw new Error('§1 must succeed first')

    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body: csvBody,
    })
    expect(res.status).toBe(200)
  })

  // ─── §3 ingest the uploaded file ──────────────────────────────────────
  // Snapshots existing batch_ids in the DAC log BEFORE the call so §4 can
  // identify which log rows are NEW (and therefore ours).
  let preIngestBatchIds = new Set<string>()
  it('§3 enqueue ingest-file job', async () => {
    if (!s.uploadKey) throw new Error('§1 must succeed first')

    const { data: pre } = await api.dataActivationClients.logs.list(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      createDac.dacSlug!,
    )
    preIngestBatchIds = new Set(
      (pre.data ?? [])
        .map((r) => (r as Record<string, unknown>).batch_id)
        .filter((b): b is string => typeof b === 'string'),
    )

    const { data } = await api.dataActivationClients.ingestFile(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      createDac.dacSlug!,
      { key: s.uploadKey },
    )
    expect(data.key).toBe(s.uploadKey)
    expect(typeof data.job_id).toBe('number')
    expect(data.job_id).toBeGreaterThan(0)
    s.ingestJobId = data.job_id ?? null
    saveSpec(INDUSTRY, 'run-dac-bulk', s)
  })

  // ─── §4 poll DAC logs until new batch's rows appear ───────────────────
  // The bulk-ingest worker generates a fresh batch_id, then fans out per-row
  // jobs. We poll for log rows with batch_ids NOT seen pre-ingest. Once we
  // see any, that batch_id is ours. We then wait until BOTH dataset_tables
  // (patients + appointments) have rows_ingested > 0 AND dataset_updated > 0.
  //
  // The dataset_updated gate is load-bearing: `rows_ingested` is set by
  // BatchCompletionHandler when the per-row Oban jobs complete, but the
  // patient row's `batch_id` UPDATE — which fires the
  // `*_increment_dataset_updated` trigger — can lag behind. If §5 POSTs
  // a SQL search filtered by `rp.batch_id = '<this>'` before that trigger
  // has fired, the SELECT matches 0 rows; the POST returns
  // status=:completed with an empty `search_results` chunk, and the
  // GET-side poll has no way to recover (the user_search is materialised
  // once and reused). Polling on dataset_updated > 0 ensures the patient
  // upserts have committed and §5's WHERE clause will match.
  it('§4 detect new batch from logs', { timeout: 90_000 }, async () => {
    if (!s.ingestJobId) throw new Error('§3 must succeed first')

    const deadline = Date.now() + 60_000
    let detectedBatchId: string | null = null
    let ourRows: Array<Record<string, unknown>> = []

    while (Date.now() < deadline) {
      const { data } = await api.dataActivationClients.logs.list(
        bootstrap.tenantSlug!,
        bootstrap.datalakeSlug!,
        createDac.dacSlug!,
      )
      const allRows = (data.data ?? []).map((r) => r as Record<string, unknown>)
      const newRows = allRows.filter((r) => {
        const b = r.batch_id
        return typeof b === 'string' && !preIngestBatchIds.has(b)
      })

      // Pick the batch that has at least one log row for both dataset
      // tables — if we see only one table, the worker is mid-fan-out.
      const byBatch = new Map<string, Array<Record<string, unknown>>>()
      for (const row of newRows) {
        const b = row.batch_id as string
        if (!byBatch.has(b)) byBatch.set(b, [])
        byBatch.get(b)!.push(row)
      }
      for (const [batchId, rows] of byBatch) {
        const topLevel = rows.filter(
          (r) => r.dataset_table === 'patients' || r.dataset_table === 'appointments',
        )
        const tables = new Set(topLevel.map((r) => r.dataset_table))
        const allReady =
          topLevel.length === 2 &&
          topLevel.every(
            (r) =>
              typeof r.rows_ingested === 'number' &&
              r.rows_ingested > 0 &&
              typeof r.dataset_updated === 'number' &&
              // Every per-row Oban job must have UPDATEd batch_id so the
              // increment_dataset_updated trigger fired for each row.
              // `> 0` would exit early when only some rows had propagated,
              // leading to `data.length < EXPECTED_ROW_COUNT` in §5/§6.
              r.dataset_updated >= r.rows_ingested,
          )
        if (tables.has('patients') && tables.has('appointments') && allReady) {
          detectedBatchId = batchId
          ourRows = rows
          break
        }
      }

      if (detectedBatchId) break
      await new Promise((r) => setTimeout(r, 1_000))
    }

    if (!detectedBatchId) {
      throw new Error(
        `did not detect a new batch with green log rows for both contracts within 60s`,
      )
    }

    s.detectedBatchId = detectedBatchId
    saveSpec(INDUSTRY, 'run-dac-bulk', s)

    console.log(`[run-dac-bulk §4] detected batch_id=${detectedBatchId}:`)
    for (const row of ourRows) {
      console.log(
        `  • dataset_table=${row.dataset_table} rows_ingested=${row.rows_ingested} dataset_updated=${row.dataset_updated}`,
      )
    }
  })

  // ─── §5 every CSV row's patient is searchable by EMR id + batch_id ────
  // The CSV has 3 rows with patient_ids 5001/5002/5003. POST creates the
  // UserSearch (status==completed), GET pages results from
  // /datasets/patient/search?user_search_id=<id>&data_access_mode=unregulated.
  // Asserts data.length >= 3 — one row landed for every CSV row, proving
  // the bulk fan-out + MDM-linked upsert worked end-to-end.
  //
  // `rp.batch_id` is required (not bare `batch_id`): both rp and ri carry
  // a batch_id column via tracking_fields() — the bare reference would
  // raise PG 42702 (ambiguous_column).
  it('§5 patients from CSV searchable via dataset-search', { timeout: 120_000 }, async () => {
    if (!s.detectedBatchId) throw new Error('§4 must succeed first')

    const valueList = BATCH1_PATIENT_IDS.map((v) => `'${v}'`).join(',')
    const { data: userSearch } = await api.datasets.createUserSearch(
      'patient',
      {
        search_query: `ri.value IN (${valueList}) AND rp.batch_id = '${s.detectedBatchId}'`,
      },
      { datalakeId: undefined },
    )

    expect(userSearch.status, `error_message=${userSearch.error_message ?? '(none)'}`).toBe(
      'completed',
    )
    if (!userSearch.id) throw new Error('user_search.id missing on POST response')

    // Async-merge tail. Bulk runs more BatchMergeWorker jobs than single
    // (3 rows × 2 contracts → more ndjson per job), so the unregulated
    // table can lag the regulated write by 30s+ on a busy machine. 90s
    // budget covers the slow tail without flapping.
    const deadline = Date.now() + 90_000
    let rows: Array<Record<string, unknown>> = []
    while (Date.now() < deadline && rows.length < EXPECTED_ROW_COUNT) {
      const { data } = await api.datasets.search('patient', {
        userSearchId: userSearch.id,
        dataAccessMode: 'unregulated',
      })
      rows = (data.data ?? []) as Array<Record<string, unknown>>
      if (rows.length < EXPECTED_ROW_COUNT) await new Promise((r) => setTimeout(r, 1_000))
    }

    expect(
      rows.length,
      `expected at least ${EXPECTED_ROW_COUNT} patient rows from unregulated GET within 90s for user_search_id=${userSearch.id}`,
    ).toBeGreaterThanOrEqual(EXPECTED_ROW_COUNT)
  })

  // ─── §6 every CSV row's appointment searchable + MDM-linked ───────────
  // Same shape as §5 but for appointments. The appointment row only
  // persists after MDM resolves the patient AND the appointment upsert
  // succeeds — both gated. Hitting EXPECTED_ROW_COUNT here is the
  // bulk-mode MDM-resolution proof.
  it('§6 appointments from CSV searchable via dataset-search', { timeout: 120_000 }, async () => {
    if (!s.detectedBatchId) throw new Error('§4 must succeed first')

    const valueList = BATCH1_APPOINTMENT_IDS.map((v) => `'${v}'`).join(',')
    const { data: userSearch } = await api.datasets.createUserSearch(
      'appointment',
      {
        search_query: `ri.value IN (${valueList}) AND ra.batch_id = '${s.detectedBatchId}'`,
      },
      { datalakeId: undefined },
    )

    expect(userSearch.status, `error_message=${userSearch.error_message ?? '(none)'}`).toBe(
      'completed',
    )
    if (!userSearch.id) throw new Error('user_search.id missing on POST response')

    // Same async-merge rationale as §5. 90s covers the slow merger tail.
    const deadline = Date.now() + 90_000
    let rows: Array<Record<string, unknown>> = []
    while (Date.now() < deadline && rows.length < EXPECTED_ROW_COUNT) {
      const { data } = await api.datasets.search('appointment', {
        userSearchId: userSearch.id,
        dataAccessMode: 'unregulated',
      })
      rows = (data.data ?? []) as Array<Record<string, unknown>>
      if (rows.length < EXPECTED_ROW_COUNT) await new Promise((r) => setTimeout(r, 1_000))
    }

    expect(
      rows.length,
      `expected at least ${EXPECTED_ROW_COUNT} appointment rows from unregulated GET within 90s for user_search_id=${userSearch.id}`,
    ).toBeGreaterThanOrEqual(EXPECTED_ROW_COUNT)
  })
})
