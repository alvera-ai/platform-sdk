/**
 * standard-workflow — Appointment Review SMS workflow over HTTP.
 *
 * The "standard" workflow shape: filter → decision (literal liquid array) →
 * scheduled tool action. No AI agents, no enrichment. Anchors the *behaviour*
 * on the gold-reference ExUnit scenario:
 *   test/platform/agentic_workflows/appointment_follow_up_sms_workflow_test.exs
 *   (the "Review SMS" workflow — sends an SMS with a connected-app form
 *   URL after a fulfilled appointment).
 *
 * Sibling: agent-driven-workflow.test.ts covers the OTHER axis — workflows
 * whose decision_key comes from an LLM enrichment node. Same pipeline, two
 * different decision sources, hence two specs.
 *
 * Previously named `agentic-workflows.test.ts`; renamed to disambiguate
 * from the agent-driven variant. Behaviourally unchanged.
 *
 * Differences from the ExUnit reference (intentional):
 *   - Filter drops the 24h recency gate. The ExUnit test mutates
 *     appointment.start to NOW() via with_dynamic_repo + raw SQL; vitest
 *     has no equivalent path, so we widen the filter to source_uri match
 *     alone. Every CSV-ingested appointment from run-dac-bulk satisfies
 *     it, which is what we want for an HTTP-only smoke.
 *   - Workflow runs against an existing fulfilled appointment from
 *     run-dac-bulk's batch (state-threaded), not a fresh CSV ingest.
 *     The full DAC→AW chain is exercised by §5.
 *
 * Spec layout:
 *   §1  create connected app (Review SMS form receiver)
 *   §2  create workflow with embedded action + context_dataset
 *       (replace-on-PUT semantics; one POST builds the whole workflow)
 *   §3  run workflow LIVE on a single fulfilled appointment, poll the
 *       batch log, execute the scheduled action, assert message persisted
 *   §4  reject-filter branch (manual_override: false) — proves filter eval
 *   §5  fresh DAC ingest → workflow scheduled action (full chain)
 *   §6  execute action → resolve token → assert tracked message
 *
 * State files this spec touches:
 *   READS:  base.state.json
 *   READS:  bootstrap.state.json   REQUIRED — tenantSlug, datalakeSlug,
 *                                  sarahSessionToken, datalakeId
 *   READS:  tools.state.json       REQUIRED — smsToolId
 *   READS:  run-dac-bulk.state.json REQUIRED — detectedBatchId
 *   READS:  standard-workflow.state.json    own prior output
 *   WRITES: standard-workflow.state.json    connectedAppId, workflowId,
 *                                           workflowSlug, lastWorkflowRunLogId
 */
import { describe, beforeAll, expect, it } from 'vitest'
import type { PlatformApi } from '@alvera-ai/platform-sdk'
import { buildApi } from '../../src/api'
import {
  type StandardWorkflowState,
  type BaseState,
  type BootstrapState,
  type CreateDacState,
  type Industry,
  type RunDacBulkState,
  type ToolsState,
  loadBase,
  loadSpec,
  requireSpec,
  saveSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Stable per-tenant; tenants are per-runId so collisions are impossible.
const CONNECTED_APP_NAME = 'Alvera Review SMS Form'
const WORKFLOW_NAME = 'Review SMS Workflow'
const WORKFLOW_DESCRIPTION =
  'Sends a review-request SMS with the connected-app form URL after a fulfilled appointment.'

// Anchor: matches data-sources.test.ts DATA_SOURCE_URI. Every CSV-ingested
// appointment from run-dac-bulk renders this on the resource.
const DATA_SOURCE_URI = '12345.athenahealth.com'

const FILTER_BODY = `{% if appointment.source_uri == "${DATA_SOURCE_URI}" %}true{% endif %}`
const FILTER_OUTPUT_SCHEMA = '{"type":"boolean"}'

// §4 filter — gates on a status that no run-dac-bulk row produces. Used to
// prove the filter-reject branch: every CSV-ingested appointment maps to
// :fulfilled, so this filter rejects everything and we get a WEL with
// status :filtered, no action scheduled.
const REJECT_FILTER_BODY =
  '{% if appointment.status == "cancelled" %}true{% endif %}'

const DECISION_KEY = 'send_appointment_review_sms'
const DECISION_BODY = `["${DECISION_KEY}"]`
const DECISION_OUTPUT_SCHEMA = '{"type":"array","items":{"type":"string"}}'

// SMS body intentionally references connected_app_form_url so the action
// pipeline mints a per-action page token (the "/t/<hash>" the ExUnit ref
// asserts on). The phone number is liquid-templated off the resolved
// regulated patient — execution-time resolution.
const SMS_TO_TEMPLATE =
  '{{ mdm_output.regulated_patient.telecom | where: "system", "phone" | first | map: "value" | e164 }}'
const SMS_BODY_TEMPLATE =
  "Hi {{ mdm_output.regulated_patient.name | first | map: \"given\" | first }}, thank you for your recent visit. " +
  "Please share your feedback at {{ connected_app_form_url }}"

// Polling parameters: per-row workflow Oban jobs run immediately in dev
// (same pattern as run-dac-bulk), but DAC ingest + MDM resolution can
// stall under a busy server, and the workflow refresh worker is its own
// async path. 5min floors are deliberately generous — the loops exit on
// success, so the floor is only paid in failure mode.
const BATCH_LOG_TIMEOUT_MS = 300_000
const BATCH_LOG_POLL_MS = 2_000
const INGEST_TIMEOUT_MS = 300_000
// §5 sums ingest poll + workflow batch poll + headroom for the it() timeout.
const INGEST_TIMEOUT_MS_PLUS_POLL = INGEST_TIMEOUT_MS + BATCH_LOG_TIMEOUT_MS + 60_000

function emptyStandardWorkflowState(): StandardWorkflowState {
  return {
    connectedAppId: null,
    connectedAppSlug: null,
    workflowId: null,
    workflowSlug: null,
    lastWorkflowRunLogId: null,
    freshIngestBatchId: null,
    freshAppointmentId: null,
  }
}

/**
 * Build a Review-SMS workflow request body. Shared by §2 (POST create)
 * and §4 (PUT update with reject-filter override). Workflow body has
 * replace-on-PUT semantics — actions/context_datasets must be sent in
 * full on every update, so factoring the shape avoids drift between
 * create and update payloads.
 */
function buildReviewSmsWorkflowBody(args: {
  filterBody: string
  smsToolId: string
  connectedAppId: string | null
}): Record<string, unknown> {
  return {
    name: WORKFLOW_NAME,
    description: WORKFLOW_DESCRIPTION,
    dataset_type: 'appointment',
    status: 'live',
    filter_config: {
      type: 'custom',
      body: args.filterBody,
      output_schema: FILTER_OUTPUT_SCHEMA,
    },
    decision_config: {
      type: 'custom',
      body: DECISION_BODY,
      output_schema: DECISION_OUTPUT_SCHEMA,
    },
    context_datasets: [
      {
        dataset_type: 'message',
        where_clause: `rm.patient_id = '{{ patient_id }}' AND rm.decision_key = '${DECISION_KEY}' AND rm.sent_at > NOW() - INTERVAL '6 months'`,
        limit: 1,
        position: 0,
      },
    ],
    actions: [
      {
        action_type: 'sms',
        tool_id: args.smsToolId,
        decision_key: DECISION_KEY,
        position: 0,
        // Literal "now" sentinel — parse_local_datetime_to_utc("now", _)
        // returns {:ok, nil} → find_datetime_slot(nil) schedules at the
        // next available slot at-or-after DateTime.utc_now/0, BYPASSING the
        // action-window clamp + queue throttle that pushed our earlier
        // `{{ "" | now | date: ... }}` rendering 3h forward.
        // Empty string "" works identically; "now" reads more clearly.
        trigger_template: 'now',
        idempotency_template:
          '{{ patient_id }}-{{ appointment.unregulated_appointment_id }}-{{ decision_key }}',
        connected_app_id: args.connectedAppId,
        connected_app_route: '/forms/review',
        connected_app_metadata_template:
          '{"appointment_id":"{{ appointment.unregulated_appointment_id }}","patient_id":"{{ mdm_output.patient.id }}"}',
        tool_call: {
          tool_call_type: 'sms_request',
          to: { type: 'custom', body: SMS_TO_TEMPLATE },
          body: { type: 'custom', body: SMS_BODY_TEMPLATE },
          sms_type: 'transactional',
        },
      },
    ],
  }
}

describe('healthcare/standard-workflow', () => {
  let base: BaseState
  let bootstrap: BootstrapState
  let tools: ToolsState
  let runDacBulk: RunDacBulkState
  let createDac: CreateDacState
  let s: StandardWorkflowState
  let api: PlatformApi
  let regulatedBucket: string

  beforeAll(async () => {
    base = loadBase(INDUSTRY)
    bootstrap = requireSpec(INDUSTRY, 'bootstrap')
    tools = requireSpec(INDUSTRY, 'tools')
    runDacBulk = requireSpec(INDUSTRY, 'run-dac-bulk')
    createDac = requireSpec(INDUSTRY, 'create-dac')
    s = loadSpec(INDUSTRY, 'standard-workflow') ?? emptyStandardWorkflowState()

    if (!bootstrap.sarahSessionToken || !bootstrap.tenantSlug || !bootstrap.datalakeSlug || !bootstrap.datalakeId) {
      throw new Error('bootstrap.state.json incomplete — sarahSessionToken/tenantSlug/datalakeSlug/datalakeId missing')
    }
    if (!tools.smsToolId) {
      throw new Error('tools.state.json incomplete — smsToolId missing (run tools spec first)')
    }
    if (!runDacBulk.detectedBatchId) {
      throw new Error('run-dac-bulk.state.json incomplete — detectedBatchId missing (run bulk DAC first)')
    }
    if (!createDac.dacSlug) {
      throw new Error('create-dac.state.json incomplete — dacSlug missing (run create-dac first)')
    }
    api = buildApi(bootstrap.sarahSessionToken)

    // Capture regulated bucket for per-step artifact downloads (filter.json,
    // enrichment.json — see fetchArtifact helper below).
    const { data: datalake } = await api.datalakes.get(bootstrap.tenantSlug!, bootstrap.datalakeId!)
    const cloudStorage = (datalake.regulated_cloud_storage ?? {}) as { bucket?: string }
    if (!cloudStorage.bucket) {
      throw new Error('datalake.regulated_cloud_storage.bucket missing — cannot download per-step artifacts')
    }
    regulatedBucket = cloudStorage.bucket
  })

  // ─── §1 create connected app (Review SMS form receiver) ────────────────
  // self_hosted mode keeps the API call simple — no GitHub repo
  // provisioning, no managed-mode preview server. The connected app's
  // role here is to mint the form URL the SMS body links to.
  it('§1 create connected app for Review SMS form', async (ctx) => {
    if (s.connectedAppId) {
      ctx.skip()
      return
    }

    const { data } = await api.connectedApps.create(bootstrap.tenantSlug!, bootstrap.datalakeSlug!, {
      name: CONNECTED_APP_NAME,
      description: 'Patient-review form linked from outbound SMS — used by the Review SMS workflow.',
      mode: 'self_hosted',
      // self_hosted mode requires at least one URL (production/staging/preview).
      // Exactly one must be is_primary: the platform discovers routes via the
      // primary URL's /.well-known/routes.json.
      urls: [
        {
          url: 'https://review.example.local',
          is_primary: true,
          label: 'production',
        },
      ],
    })

    expect(data.id).toMatch(UUID_RE)
    expect(data.name).toBe(CONNECTED_APP_NAME)
    expect(data.mode).toBe('self_hosted')
    s.connectedAppId = data.id ?? null
    s.connectedAppSlug = data.slug ?? null
    saveSpec(INDUSTRY, 'standard-workflow', s)
  })

  // ─── §2 create workflow with embedded action + context_dataset ─────────
  // The agentic_workflows controller accepts `actions` and `context_datasets`
  // arrays inline with replace-on-PUT semantics — one POST builds the whole
  // workflow. Mirrors the ExUnit `create_review_sms_workflow` helper.
  it('§2 create Review SMS workflow', async (ctx) => {
    if (s.workflowId) {
      ctx.skip()
      return
    }

    const { data } = await api.workflows.create(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      buildReviewSmsWorkflowBody({
        filterBody: FILTER_BODY,
        smsToolId: tools.smsToolId!,
        connectedAppId: s.connectedAppId,
      }),
    )

    expect(data.id).toMatch(UUID_RE)
    expect(data.name).toBe(WORKFLOW_NAME)
    expect(data.status).toBe('live')
    expect(data.dataset_type).toBe('appointment')
    expect(data.actions).toHaveLength(1)
    expect(data.context_datasets).toHaveLength(1)
    s.workflowId = data.id ?? null
    s.workflowSlug = data.slug ?? null
    saveSpec(INDUSTRY, 'standard-workflow', s)
  })

  // ─── §3 run workflow LIVE on a single fulfilled appointment ────────────
  // This is the headline parity test against the ExUnit Review SMS
  // workflow. The shape is HTTP-only:
  //   1. Pick one fulfilled appointment from run-dac-bulk's batch via
  //      datasets/appointment/search (the post→get claims-pattern).
  //   2. POST runWorkflow with sql_where_clause pinned to that exact ID.
  //   3. Poll the workflow_run_log batch entry until status flips to a
  //      terminal state (the per-row Oban job has finished evaluating).
  //   4. Assert enqueued_count == 1 and the run reached completion.
  //
  // We stop short of asserting "message in messages dataset" — that
  // requires either (a) the workflow's daily DynamicCron picking up the
  // scheduled action (24h wait, infeasible) or (b) calling execute
  // manually with the right (dataset_id, decision_key) tuple. The latter
  // is a follow-up commit.
  it('§3 runWorkflow on a single fulfilled appointment (live mode)', async () => {
    if (!s.workflowSlug) throw new Error('§2 must succeed first')

    // Step 1 — find a fulfilled appointment from the bulk batch. Use the
    // claims-pattern: POST a user-search, then GET its results. `ra` =
    // regulated_appointments; both ra and rp carry batch_id so the
    // prefix disambiguates the join.
    const { data: userSearch } = await api.datasets.createUserSearch(
      'appointment',
      {
        search_query: `ra.batch_id = '${runDacBulk.detectedBatchId}' AND ra.status = 'fulfilled'`,
      },
      { datalakeId: undefined },
    )
    if (userSearch.status !== 'completed') {
      throw new Error(
        `appointment user-search status=${userSearch.status} error_message=${userSearch.error_message ?? '(none)'}`,
      )
    }
    if (!userSearch.id) throw new Error('user_search.id missing on POST response')

    // Don't pass pageSize — the SDK wrapper sends it as flat `page_size`,
    // but the server's :search expects nested `outer_pagination[page_size]`
    // (see dataset_controller.ex). Pre-existing SDK shape mismatch; using
    // server defaults (1 outer page × 20 inner) is plenty for a single
    // batched fulfilled appointment.
    const { data: searchGet } = await api.datasets.search('appointment', {
      datalakeId: bootstrap.datalakeId!,
      userSearchId: userSearch.id,
    })
    expect(searchGet.data?.length ?? 0).toBeGreaterThan(0)
    const appointmentId = (searchGet.data![0] as { id: string }).id
    expect(appointmentId).toMatch(UUID_RE)

    // Step 2 — fire the workflow against this one appointment, live mode.
    // sql_where_clause pins to the exact ID so we get a single-row batch.
    // sql_where_clause runs against the same multi-JOIN base query as the
    // dataset user-search, so `id` alone is ambiguous (multiple tables in
    // the join expose it). Prefix with `ra` (regulated_appointments) to
    // pin to the appointment row.
    //
    // mode enum is just `live | dry_run`. `manual_override: true` skips
    // BOTH the workflow filter expression AND the idempotency check,
    // i.e. it forces the decision + action scheduling to run regardless
    // of whether the row would normally pass the filter and regardless
    // of whether the idempotency tuple has already fired. This makes
    // the test deterministic across reruns at the cost of not exercising
    // the filter logic — that belongs in dedicated filter tests.
    //
    // Per-row jobs still run through Oban async, so the batch-log
    // refresh poll below is the synchronization point.
    const { data: runResp } = await api.workflows.run(bootstrap.tenantSlug!, s.workflowSlug!, {
      sql_where_clause: `ra.id = '${appointmentId}'`,
      mode: 'live',
      manual_override: true,
    })
    // batch_id carries a runtime tag prefix (e.g. "manual:<uuid>") so it
    // can be distinguished from cron-driven batches; only assert non-empty.
    // workflow_run_log_id is the row id and IS a plain UUID.
    expect(runResp.batch_id?.length ?? 0).toBeGreaterThan(0)
    expect(runResp.workflow_run_log_id).toMatch(UUID_RE)
    expect(runResp.enqueued_count).toBe(1)
    s.lastWorkflowRunLogId = runResp.workflow_run_log_id ?? null
    saveSpec(INDUSTRY, 'standard-workflow', s)

    // Step 3 — poll the batch log until it leaves :pending. The
    // WorkflowRunLog status enum is :pending | :completed | :failed |
    // :partial. Both modes (live and manual+override) enqueue per-row
    // Oban jobs asynchronously; the run-log status only flips when an
    // explicit refresh observes that all jobs are done. We call
    // batchLogs.refresh on each iteration to force the recomputation —
    // it returns the updated BatchLogResponse in one call.
    const startedAt = Date.now()
    let terminalStatus: 'completed' | 'failed' | 'partial' | null = null
    while (Date.now() - startedAt < BATCH_LOG_TIMEOUT_MS) {
      const { data: log } = await api.workflows.batchLogs.refresh(
        bootstrap.tenantSlug!,
        s.workflowSlug!,
        runResp.workflow_run_log_id!,
      )
      if (log.status && log.status !== 'pending') {
        terminalStatus = log.status
        break
      }
      await new Promise((r) => setTimeout(r, BATCH_LOG_POLL_MS))
    }

    if (!terminalStatus) {
      throw new Error(
        `WorkflowRunLog did not leave :pending within ${BATCH_LOG_TIMEOUT_MS}ms ` +
          `(workflow_run_log_id=${runResp.workflow_run_log_id})`,
      )
    }
    // Filter passes (source_uri matches), decision returns one key, action
    // gets scheduled — :completed is the happy outcome; :partial means
    // some rows skipped (also acceptable for a single-row batch where
    // recency lookups may opt out). :failed is the only signal we reject.
    expect(terminalStatus).not.toBe('failed')

    // Per-step artifacts: locate this run's WEL by batch_id and assert
    // filter.json (pass branch) + enrichment.json (skipped — this workflow
    // has no AI agents). This covers gaps F-pass + H from the Stage 2
    // vitest audit by exercising the empty-agents enrichment branch in
    // execute_enrichment_nodes/4.
    const { data: wfLogs } = await api.workflows.workflowLogs.list(bootstrap.tenantSlug!, s.workflowSlug!)
    const ourWels = (wfLogs.data ?? []).filter(
      (w) => (w as { batch_id?: string }).batch_id === runResp.batch_id,
    )
    expect(ourWels.length).toBeGreaterThan(0)
    const wel = ourWels[0] as { id?: string; workflow_id?: string }

    const filterJson = await fetchArtifact<{ filter_expression: string; filter_result: boolean }>(
      api, bootstrap, regulatedBucket, wel, 'filter',
    )
    // The standard workflow's filter is a Liquid expression; pass-branch
    // means filter_result: true regardless of body shape.
    expect(filterJson.filter_result).toBe(true)
    expect(filterJson.filter_expression).toBeTypeOf('string')

    const enrichmentJson = await fetchArtifact<{ status: string }>(
      api, bootstrap, regulatedBucket, wel, 'enrichment',
    )
    // No AI agents wired to this workflow → execute_enrichment_nodes/4
    // takes the empty-agents branch: %{"status" => "skipped"}.
    expect(enrichmentJson.status).toBe('skipped')
  }, BATCH_LOG_TIMEOUT_MS + 30_000)

  // ─── §4 filter REJECT branch — manual_override: false ─────────────────
  // Proves the filter expression actually evaluates. PUTs the workflow
  // with a filter that gates on appointment.status == "cancelled" — no
  // run-dac-bulk row produces that status (all CSV rows map to :fulfilled),
  // so the filter rejects every match. With manual_override: false, the
  // filter IS evaluated; we expect the per-row WorkflowExecutionLog to
  // land with status :filtered.
  //
  // This is the "vitest is better than Playwright" payoff: branch coverage
  // by payload variation. One additional HTTP call (PUT) is enough to
  // flip the workflow into a different filter branch and re-fire.
  it('§4 runWorkflow with reject filter records WEL :filtered', async () => {
    if (!s.workflowId || !s.workflowSlug) throw new Error('§2 must succeed first')

    // Step 1 — PUT update workflow filter to reject everything fulfilled.
    // Replace-on-PUT means the full body must be sent (omitting actions
    // would silently delete them).
    await api.workflows.update(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      s.workflowId,
      buildReviewSmsWorkflowBody({
        filterBody: REJECT_FILTER_BODY,
        smsToolId: tools.smsToolId!,
        connectedAppId: s.connectedAppId,
      }),
    )

    // Step 2 — find a fulfilled appointment. Same claims-pattern as §3.
    const { data: userSearch } = await api.datasets.createUserSearch(
      'appointment',
      {
        search_query: `ra.batch_id = '${runDacBulk.detectedBatchId}' AND ra.status = 'fulfilled'`,
      },
      { datalakeId: undefined },
    )
    if (userSearch.status !== 'completed' || !userSearch.id) {
      throw new Error(`appointment user-search status=${userSearch.status}`)
    }
    const { data: searchGet } = await api.datasets.search('appointment', {
      datalakeId: bootstrap.datalakeId!,
      userSearchId: userSearch.id,
    })
    expect(searchGet.data?.length ?? 0).toBeGreaterThan(0)
    const appointmentId = (searchGet.data![0] as { id: string }).id

    // Step 3 — fire workflow with manual_override: false so the filter is
    // actually evaluated.
    const { data: runResp } = await api.workflows.run(bootstrap.tenantSlug!, s.workflowSlug!, {
      sql_where_clause: `ra.id = '${appointmentId}'`,
      mode: 'live',
      manual_override: false,
    })
    expect(runResp.workflow_run_log_id).toMatch(UUID_RE)
    expect(runResp.enqueued_count).toBe(1)

    // Step 4 — poll until terminal. With a reject filter the WEL still
    // gets recorded (status :filtered) and the run log reaches a terminal
    // state quickly — no action scheduling work.
    const startedAt = Date.now()
    let terminalStatus: 'completed' | 'failed' | 'partial' | null = null
    while (Date.now() - startedAt < BATCH_LOG_TIMEOUT_MS) {
      const { data: log } = await api.workflows.batchLogs.refresh(
        bootstrap.tenantSlug!,
        s.workflowSlug!,
        runResp.workflow_run_log_id!,
      )
      if (log.status && log.status !== 'pending') {
        terminalStatus = log.status
        break
      }
      await new Promise((r) => setTimeout(r, BATCH_LOG_POLL_MS))
    }
    if (!terminalStatus) {
      throw new Error(
        `WorkflowRunLog did not leave :pending within ${BATCH_LOG_TIMEOUT_MS}ms ` +
          `(workflow_run_log_id=${runResp.workflow_run_log_id})`,
      )
    }
    expect(terminalStatus).not.toBe('failed')

    // Step 5 — locate our WEL by batch_id and assert it was filtered.
    // workflowLogs.list returns all logs for this workflow; we filter
    // client-side because the SDK doesn't expose a batch_id query param.
    // WEL.batch_id matches the runResp.batch_id (tagged string like
    // "manual:<uuid>").
    const { data: logsList } = await api.workflows.workflowLogs.list(
      bootstrap.tenantSlug!,
      s.workflowSlug!,
    )
    const ourWels = (logsList.data ?? []).filter(
      (w) => (w as { batch_id?: string }).batch_id === runResp.batch_id,
    )
    expect(ourWels.length).toBeGreaterThan(0)
    const filteredWels = ourWels.filter((w) => (w as { status?: string }).status === 'filtered')
    expect(filteredWels.length).toBeGreaterThan(0)

    // Reject-branch artifact: filter.json should carry filter_result: false
    // (gap F-reject). This is the symmetric proof to §3's filter_result: true
    // — both branches of evaluate_filter/4 in agentic_workflows.ex emit
    // filter.json, the body just differs.
    const rejectedWel = filteredWels[0] as { id?: string; workflow_id?: string }
    const filterJson = await fetchArtifact<{ filter_expression: string; filter_result: boolean }>(
      api, bootstrap, regulatedBucket, rejectedWel, 'filter',
    )
    expect(filterJson.filter_result).toBe(false)
    expect(filterJson.filter_expression).toBeTypeOf('string')
  }, BATCH_LOG_TIMEOUT_MS + 30_000)

  // ─── §5 fresh DAC ingest → workflow scheduled action ──────────────────
  // Full DAC→AW chain. Generates fresh patient_id and appointment_id so
  // MDM produces a NEW patient (no idempotency dedupe against §3's run),
  // ingests one row, waits for resolution, restores the workflow filter
  // (§4 left it gating on cancelled), and runs the workflow with
  // manual_override: false so filter + idempotency are both honoured.
  //
  // source_uri is intentionally NOT in the payload — it flows from the
  // data_source URI ('12345.athenahealth.com' from data-sources.test.ts)
  // through the contract template, which is what the workflow filter
  // gates on. Including it in the row would risk overriding that path.
  it('§5 fresh-ingest a unique appointment and run workflow', async () => {
    if (!s.workflowId || !s.workflowSlug) throw new Error('§2 must succeed first')

    // Step 1 — fresh per-run IDs. EMR identifiers are namespaced by run
    // suffix so no MDM merge collides with prior runs.
    const RUN_SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
    const EMR_PATIENT_ID = `aw5-pt-${RUN_SUFFIX}`
    const EMR_APPOINTMENT_ID = `aw5-appt-${RUN_SUFFIX}`

    // Step 2 — ingest a single CAHPS-shaped row. Same shape as
    // run-dac-single's CAHPS_ROW minus the explicit source_uri override
    // (we want the data_source URI to flow through the template).
    const { data: ingestResp } = await api.dataActivationClients.ingest(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      createDac.dacSlug!,
      {
        data: {
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
          patient_name: 'Walker Aw5',
          patientdob: '7/22/1950',
          patient_mobile_no: '555-943-2718',
          patient_risk_level: 'medium',
          svc_department: 'EASTSIDE',
          rndrng_provider_id: '602',
          rndrng_provider: 'Dr. Thomas Nguyen',
        },
      },
    )
    expect(ingestResp.batch_id).toMatch(UUID_RE)
    s.freshIngestBatchId = ingestResp.batch_id ?? null

    // Step 3 — find the freshly ingested appointment. Two-phase per the
    // pattern in run-dac-single §4:
    //   (a) POST createUserSearch loops until the SQL search itself
    //       reports status :completed (i.e. the search has run and any
    //       matching rows are materialised in `search_results`).
    //   (b) GET datasets.search polls until rows are returned. The POST
    //       response's `results_count` is always null — actual rows
    //       only become visible via the paginated GET.
    //
    // Looping the POST is necessary because each search_query creates
    // a NEW UserSearch row; if MDM hasn't finished resolving the
    // appointment yet, the search returns 0 matches and we have to
    // re-issue once the row lands.
    const startedAt = Date.now()
    let userSearchId: string | null = null
    while (Date.now() - startedAt < INGEST_TIMEOUT_MS && !userSearchId) {
      const { data: us } = await api.datasets.createUserSearch(
        'appointment',
        {
          search_query: `ri.value = '${EMR_APPOINTMENT_ID}' AND ra.batch_id = '${ingestResp.batch_id}'`,
        },
        { datalakeId: undefined },
      )
      if (us.status === 'completed' && us.id) {
        // Quick GET probe: did this search find anything?
        const { data: probe } = await api.datasets.search('appointment', {
          datalakeId: bootstrap.datalakeId!,
          userSearchId: us.id,
        })
        if ((probe.data?.length ?? 0) > 0) {
          userSearchId = us.id
          break
        }
      }
      await new Promise((r) => setTimeout(r, 2_000))
    }
    if (!userSearchId) {
      throw new Error(
        `fresh appointment ${EMR_APPOINTMENT_ID} did not land in batch ${ingestResp.batch_id} within ${INGEST_TIMEOUT_MS}ms`,
      )
    }
    // Regulated id — runWorkflow's sql_where_clause runs against the
    // regulated tables (`ra` = regulated_appointments) below. §6 does
    // its own unregulated-mode search to get the dataset_id needed by
    // workflows.execute.
    const { data: searchGet } = await api.datasets.search('appointment', {
      datalakeId: bootstrap.datalakeId!,
      userSearchId,
    })
    expect(searchGet.data?.length ?? 0).toBeGreaterThan(0)
    const appointmentId = (searchGet.data![0] as { id: string }).id
    expect(appointmentId).toMatch(UUID_RE)
    s.freshAppointmentId = appointmentId
    saveSpec(INDUSTRY, 'standard-workflow', s)

    // Step 4 — restore the workflow filter to source_uri match (§4 left
    // it gating on cancelled). Idempotent: PUT replaces the body wholesale.
    await api.workflows.update(
      bootstrap.tenantSlug!,
      bootstrap.datalakeSlug!,
      s.workflowId,
      buildReviewSmsWorkflowBody({
        filterBody: FILTER_BODY,
        smsToolId: tools.smsToolId!,
        connectedAppId: s.connectedAppId,
      }),
    )

    // Step 5 — run workflow with manual_override: false. Filter PASSES
    // (source_uri matches data_source URI). Fresh patient + appointment
    // means idempotency tuple has never fired — action gets scheduled.
    const { data: runResp } = await api.workflows.run(bootstrap.tenantSlug!, s.workflowSlug!, {
      sql_where_clause: `ra.id = '${appointmentId}'`,
      mode: 'live',
      manual_override: false,
    })
    expect(runResp.workflow_run_log_id).toMatch(UUID_RE)
    expect(runResp.enqueued_count).toBe(1)
    s.lastWorkflowRunLogId = runResp.workflow_run_log_id ?? null
    saveSpec(INDUSTRY, 'standard-workflow', s)

    // Step 6 — poll batch log until terminal. Refresh per cycle.
    const pollStarted = Date.now()
    let terminalStatus: 'completed' | 'failed' | 'partial' | null = null
    while (Date.now() - pollStarted < BATCH_LOG_TIMEOUT_MS) {
      const { data: log } = await api.workflows.batchLogs.refresh(
        bootstrap.tenantSlug!,
        s.workflowSlug!,
        runResp.workflow_run_log_id!,
      )
      if (log.status && log.status !== 'pending') {
        terminalStatus = log.status
        break
      }
      await new Promise((r) => setTimeout(r, BATCH_LOG_POLL_MS))
    }
    if (!terminalStatus) {
      throw new Error(
        `WorkflowRunLog did not leave :pending within ${BATCH_LOG_TIMEOUT_MS}ms`,
      )
    }
    expect(terminalStatus).not.toBe('failed')

    // Step 7 — assert at least one WEL for this batch reached :completed
    // (filter passed → decision returned → action scheduled). The actual
    // execute + message-persisted assertions land in §6.
    const { data: logsList } = await api.workflows.workflowLogs.list(
      bootstrap.tenantSlug!,
      s.workflowSlug!,
    )
    const ourWels = (logsList.data ?? []).filter(
      (w) => (w as { batch_id?: string }).batch_id === runResp.batch_id,
    )
    expect(ourWels.length).toBeGreaterThan(0)
    const completedWels = ourWels.filter(
      (w) => (w as { status?: string }).status === 'completed',
    )
    expect(completedWels.length).toBeGreaterThan(0)
  }, INGEST_TIMEOUT_MS_PLUS_POLL)

  // ─── §6 execute action → resolve token → assert tracked message ───────
  // Closes the loop with the connected_app_controller surface that the
  // ExUnit reference asserts on:
  //   * The action renders an SMS body containing /t/<token>
  //   * The token resolves via connectedApps.resolvePage to a message
  //     with the expected body
  //   * connectedApps.updateMessageTracking populates opened_at /
  //     form_submitted_at on the message record
  //
  // execute() bypasses filter + decision evaluation — it directly fires
  // a specific action on a specific dataset row. Combined with §5's
  // freshAppointmentId (no idempotency dedupe), this is the cleanest
  // path to a freshly-rendered message we can introspect.
  it('§6 execute action, resolve token, update tracking', async () => {
    if (!s.workflowSlug || !s.connectedAppSlug || !s.freshAppointmentId || !s.freshIngestBatchId) {
      throw new Error('§5 must succeed first (need freshAppointmentId + connectedAppSlug + freshIngestBatchId)')
    }

    // Step 0 — workflows.execute operates on the UNREGULATED dataset id
    // (cross-tenant safety + the unregulated schema is what workflow
    // actions read context from). §5 saved the regulated id (used for
    // its sql_where_clause). Re-search in unregulated mode pinned to
    // §5's batch to get the unregulated_appointment id.
    const { data: usU } = await api.datasets.createUserSearch(
      'appointment',
      {
        search_query: `ra.id = '${s.freshAppointmentId}' AND ra.batch_id = '${s.freshIngestBatchId}'`,
      },
      { datalakeId: undefined },
    )
    if (usU.status !== 'completed' || !usU.id) {
      throw new Error(`unregulated user-search status=${usU.status}`)
    }
    const { data: probeU } = await api.datasets.search('appointment', {
      datalakeId: bootstrap.datalakeId!,
      userSearchId: usU.id,
      dataAccessMode: 'unregulated',
    })
    expect(probeU.data?.length ?? 0).toBeGreaterThan(0)
    const unregulatedAppointmentId = (probeU.data![0] as { id: string }).id
    expect(unregulatedAppointmentId).toMatch(UUID_RE)

    // Step 1 — fire the action directly on §5's fresh appointment.
    // `manual_override: true` is load-bearing — §5's run_workflow already
    // processed this same sampled_event, so /execute's default
    // (manual_override:false) would hit the ActionExecutor's unique-key
    // constraint on (sampled_event_id, action_id) and silently dedupe the
    // Oban insert (uniq_conflict:true), leaving the new AEL in :pending
    // forever. The override sets unique:false on the Oban job so §6's
    // re-fire produces a fresh runnable job.
    const { data: execResp } = await api.workflows.execute(
      bootstrap.tenantSlug!,
      s.workflowSlug,
      {
        dataset_id: unregulatedAppointmentId,
        decision_key: DECISION_KEY,
        manual_override: true,
      },
    )
    expect(execResp.status).toMatch(/^(pending|completed|filtered|failed)$/)
    if (!execResp.workflow_execution_log_id) {
      throw new Error('execute returned no workflow_execution_log_id')
    }
    const welId = execResp.workflow_execution_log_id

    // Step 2 — poll the WEL until terminal. execute is documented as
    // "nil when async" for workflow_execution_log_id, but we got one
    // back so this WEL is real and pollable.
    const pollStarted = Date.now()
    let welStatus: string | null = null
    while (Date.now() - pollStarted < BATCH_LOG_TIMEOUT_MS) {
      const { data: wel } = await api.workflows.workflowLogs.get(
        bootstrap.tenantSlug!,
        s.workflowSlug,
        welId,
      )
      welStatus = (wel as { status?: string }).status ?? null
      if (welStatus && welStatus !== 'pending' && welStatus !== 'executing') break
      await new Promise((r) => setTimeout(r, BATCH_LOG_POLL_MS))
    }
    if (!welStatus) throw new Error(`WEL ${welId} never reported a status`)
    expect(welStatus).not.toBe('failed')

    // Step 3 — read the rendered SMS body straight off the WEL show
    // response. The server populates each AEL's `message_body` virtual
    // field by fetching the linked datalake message in the requested
    // mode (regulated → raw rendered string with `/t/<url_hash>`;
    // unregulated → tokenised display string). Pinned by the in-process
    // Elixir round-trip (appointment_follow_up_sms_workflow_test.exs)
    // and the HTTP round-trip ("GET /workflow-logs/:id — message_body
    // populated by data_access_mode override") in
    // appointment_follow_up_sms_workflow_http_test.exs.
    const { data: regulatedWel } = await api.workflows.workflowLogs.get(
      bootstrap.tenantSlug!,
      s.workflowSlug,
      welId,
      { dataAccessMode: 'regulated' },
    )

    const aelWithBody = (regulatedWel.action_execution_logs ?? []).find(
      (ael) => typeof ael.message_body === 'string' && ael.message_body.length > 0,
    )
    if (!aelWithBody?.message_body) {
      throw new Error(
        `no AEL with message_body on WEL ${welId} — got ${JSON.stringify(regulatedWel.action_execution_logs)}`,
      )
    }
    expect(aelWithBody.workflow_execution_log_id).toBe(welId)
    expect(aelWithBody.status).toBe('completed')

    // Step 4 — extract /t/<token> from the rendered body. Puid format
    // (alphanumeric + dash + underscore).
    const tokenMatch = aelWithBody.message_body.match(/\/t\/([A-Za-z0-9_-]+)/)
    if (!tokenMatch || !tokenMatch[1]) {
      throw new Error(`no /t/<token> in AEL message_body: ${aelWithBody.message_body}`)
    }
    const shortPath = tokenMatch[1]

    // Step 5 — resolve the page. Returns the regulated message
    // including the raw rendered body — that's the assertion target.
    const { data: resolved } = await api.connectedApps.resolvePage(
      bootstrap.tenantSlug!,
      s.connectedAppSlug,
      {
        short_path: shortPath,
        user_agent: 'vitest-e2e/standard-workflow',
      },
    )
    expect(resolved.message?.body ?? '').toMatch(/connected_app_form_url|\/t\//i)
    // The route_path on the workflow action was '/forms/review' (§2 body).
    expect(resolved.route_path).toBe('/forms/review')

    // Step 6 — update tracking. Mirrors what the connected-app frontend
    // does when a customer opens the page and submits the form.
    const now = new Date().toISOString()
    const { data: tracked } = await api.connectedApps.updateMessageTracking(
      bootstrap.tenantSlug!,
      s.connectedAppSlug,
      {
        short_path: shortPath,
        opened_at: now,
        form_submitted_at: now,
      },
    )
    expect(tracked.message?.opened_at).toBeTruthy()
    expect(tracked.message?.form_submitted_at).toBeTruthy()
  }, BATCH_LOG_TIMEOUT_MS + 60_000)
})

// ─── helpers ────────────────────────────────────────────────────────────────

// Round-trip a per-step JSON artifact for a WEL. Mirrors the helper of the
// same shape in agent-driven-workflow.test.ts; the two specs share the
// upload convention (`workflows/<wf_id>/executions/<wel_id>/<step>.json`)
// emitted by `Platform.AgenticWorkflows.upload_wel_step_artifact/4`.
async function fetchArtifact<T>(
  api: PlatformApi,
  bootstrap: BootstrapState,
  bucket: string,
  wel: { id?: string; workflow_id?: string },
  step: 'event' | 'filter' | 'enrichment' | 'error',
): Promise<T> {
  if (!wel.id || !wel.workflow_id) {
    throw new Error(`WEL is missing id or workflow_id: ${JSON.stringify(wel)}`)
  }
  const key = `workflows/${wel.workflow_id}/executions/${wel.id}/${step}.json`

  const { data: link } = await api.datalakes.createDownloadLink(
    bootstrap.tenantSlug!,
    bootstrap.datalakeSlug!,
    { bucket, key },
  )

  if (!link.url) throw new Error(`download-link returned no url for key=${key}`)

  const resp = await fetch(link.url)
  if (!resp.ok) {
    throw new Error(`${step}.json fetch failed: ${resp.status} ${resp.statusText} (key=${key})`)
  }
  return (await resp.json()) as T
}
