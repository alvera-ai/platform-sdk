/**
 * agent-driven-workflow — Contact Us Triage workflow with LLM enrichment.
 *
 * Sibling spec to `standard-workflow.test.ts`. Same pipeline (filter →
 * decision → action) but with an enrichment AI agent driving the decision
 * key instead of a static liquid array.
 *
 * Mirrors the in-process Elixir scenario at
 *   test/platform/agentic_workflows/generic_table_workflow_test.exs (§349-707)
 * and its HTTP companion at
 *   test/platform_api/controllers/agent_driven_contact_us_workflow_http_test.exs
 *
 * Two branches:
 *   * positive — 3 submissions → 3 distinct decision_keys → 3 SMS AELs.
 *   * transport — a SECOND LLM tool is wired to a wrong path on Ollama
 *                 (e.g. `/wrong-path/...`); the workflow fails with
 *                 `error_code: "tool_execution_failed"`. The exact
 *                 transport-level cause (404, connection refused, …) is
 *                 unimportant; what matters is the platform's mapping into
 *                 the canonical `:tool_execution_failed` code.
 *
 * For the negative branch we round-trip the error.json artifact: download
 * the per-step file from regulated cloud storage via the existing datalake
 * download-link endpoint and assert `error_code` matches. This is the
 * vitest-side validation of the per-step artifact contract introduced in
 * Stage 1 (lib/platform/agentic_workflows.ex `upload_wel_step_artifact/4`).
 * The mapping-failure branch (context_mapping_failed) is owned by the
 * Stage 1 Elixir HTTP test; it isn't re-exercised here.
 *
 * State files this spec touches:
 *   READS:  base.state.json
 *   READS:  bootstrap (tenantSlug, datalakeSlug, sarahSessionToken, datalakeId)
 *   READS:  custom-datasets (contactUsTableId, contactUsTableName)
 *   READS:  interoperability-contracts (contactUsContractId)
 *   READS:  create-dac (contactUsDacId, contactUsDacSlug)
 *   READS:  tools (smsToolId)
 *   READS:  agent-driven-workflow.state.json   own prior output (rerun)
 *   WRITES: agent-driven-workflow.state.json   tool/agent/workflow ids
 */
import { describe, beforeAll, expect, it } from 'vitest'
import type { PlatformApi } from '@alvera-ai/platform-sdk'
import { buildApi } from '../../src/api'
import { config } from '../../src/env'
import {
  type AgentDrivenWorkflowState,
  type BootstrapState,
  type CreateDacState,
  type CustomDatasetsState,
  type Industry,
  type InteropContractsState,
  type ToolsState,
  loadSpec,
  requireSpec,
  saveSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const LLM_TOOL_NAME = 'Alvera Ollama Chat Completion'
const LLM_TOOL_FAILING_NAME = 'Alvera Ollama Chat Completion — Bad Path'
const AGENT_NAME = 'Contact Us Triage Categorizer'
const WORKFLOW_POS_NAME = 'Contact Us Triage'
const WORKFLOW_TRANSPORT_NAME = 'Contact Us Triage — Bad LLM URL'

// Decision keys — one per category the LLM may return. The agent's
// prompt asks for one of these literal strings, the decision_config
// liquid expression interpolates `additional_context.<agent_slug>.category`,
// and the platform fans out exactly the matching action.
const DECISION_APPOINTMENT = 'appointment_request'
const DECISION_JOB = 'job_inquiry'
const DECISION_SPAM = 'flag_spam'

// Three submissions modelled to be ~unambiguous to a small Ollama model.
// EMR identifiers are namespaced by run suffix at runtime (§6) so MDM
// dedupe doesn't collide across runs.
const SUBMISSION_APPOINTMENT = {
  name: 'Maria Garcia',
  email: 'maria@example.com',
  message:
    'I would like to schedule an appointment with Dr. Johnson next week if possible.',
}
const SUBMISSION_JOB = {
  name: 'James Wilson',
  email: 'james@example.com',
  message:
    'I am a registered nurse looking for employment opportunities at your clinic.',
}
const SUBMISSION_SPAM = {
  name: 'BestDeals2026',
  email: 'promo@cheapmeds.xyz',
  message:
    'HUGE DISCOUNT on cheap medications and miracle cures! CLICK HERE NOW for 90% off!',
}

const TRIAGE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    msg: { type: 'string' },
    submission_id: { type: 'string' },
  },
  required: ['msg', 'submission_id'],
}

// Tells the LLM to emit only `{"category": <one of the three>}` — no prose,
// no code fences. The runner forwards this via `response_format: json_schema`
// in the chat completion request body so Ollama's structured-output mode
// constrains decoding. Without it, small Ollama models often wrap the
// answer in markdown code fences or chat preamble, which the runner's
// `Jason.decode/1` of `choices[0].message.content` then rejects with
// `:json_decode_failed`.
const TRIAGE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: [DECISION_APPOINTMENT, DECISION_JOB, DECISION_SPAM],
    },
  },
  required: ['category'],
  additionalProperties: false,
}

// Ollama endpoint (OpenAI-compatible). Model from env (`config.ollamaModel`)
// must be pulled locally before the spec runs — the bootstrap preflight
// already enforces this for the run as a whole.
//
// `base_url` is the prefix the platform's REST chat-completion protocol
// appends `/chat/completions` to (see lib/platform/tools/chat_completion_protocol.ex
// — `RESTAPI` impl: `path: "/chat/completions"`). So we point at the OpenAI
// API root (`/v1`) rather than `/v1/chat/completions` directly — otherwise
// the platform produces `/v1/chat/completions/chat/completions` and Ollama
// 404s. The bad-path constant uses an obviously wrong prefix to deliberately
// drive the `tool_execution_failed` branch in §8.
const OLLAMA_BASE = 'http://localhost:11434/v1'
const OLLAMA_BAD_PATH = 'http://localhost:11434/wrong-path/that/does/not/exist'

// Timeouts: real Ollama with a small model on a quiet box is ~3-5s per
// call. Three calls in the positive run + DDL + workflow scheduling fits
// well under 60s on the happy path; pad generously.
const OLLAMA_RUN_TIMEOUT_MS = 180_000
const BATCH_LOG_TIMEOUT_MS = 180_000
const BATCH_LOG_POLL_MS = 2_000

// Captured by beforeAll for raw-fetch helpers that bypass the SDK when its
// response schema doesn't admit the live response shape (e.g., polymorphic
// body discriminated unions returning a superset of fields).
let apiSessionToken: string

function emptyAgentDriven(): AgentDrivenWorkflowState {
  return {
    llmToolId: null,
    llmToolFailingId: null,
    agentId: null,
    agentSlug: null,
    workflowPosId: null,
    workflowPosSlug: null,
    workflowTransportId: null,
    workflowTransportSlug: null,
    lastBatchId: null,
  }
}

// Liquid template for the agent's prompt. The agent is asked to categorize
// the submission into one of the three decision_keys. Temperature 0.0 gets
// us deterministic-ish behaviour from a small model.
const AGENT_PROMPT_BODY = `You are a triage assistant. Categorize the following message into EXACTLY ONE of these categories:

- "${DECISION_APPOINTMENT}" — the user wants to book/reschedule a medical appointment
- "${DECISION_JOB}" — the user is asking about employment or job opportunities
- "${DECISION_SPAM}" — the message is promotional / spam / irrelevant

Submission ID: {{ submission_id }}
Message: {{ msg }}

Respond with a JSON object: {"category": "<one of the three categories above>"}`

const FULL_MAPPING_BODY = JSON.stringify({
  msg: '{{ event_dataset.message }}',
  submission_id: '{{ event_dataset.submission_id }}',
})

const DECISION_CONFIG_BODY = (agentSlug: string) =>
  `["{{ additional_context.${agentSlug}.category }}"]`

const DECISION_OUTPUT_SCHEMA = JSON.stringify({
  type: 'array',
  items: { type: 'string' },
})

// Single SMS action template, parameterised by decision_key. The positive
// workflow has all three actions; negative workflows only need one (the
// branch fails before any action gets scheduled, but the workflow needs
// at least one action to be a valid create body).
function smsAction(decisionKey: string, smsToolId: string) {
  return {
    decision_key: decisionKey,
    action_type: 'sms',
    tool_id: smsToolId,
    position: 0,
    trigger_template: 'now',
    idempotency_template: `{{ checksum }}-{{ action_id }}-${decisionKey}`,
    tool_call: {
      tool_call_type: 'sms_request',
      to: { type: 'custom', body: '+15551234567' },
      body: {
        type: 'custom',
        body: `Triage [${decisionKey}]: {{ event_dataset.message }}`,
      },
      sms_type: 'transactional',
    },
  }
}

describe('healthcare/agent-driven-workflow', () => {
  let bootstrap: BootstrapState
  let customDatasets: CustomDatasetsState
  let interop: InteropContractsState
  let createDac: CreateDacState
  let tools: ToolsState
  let s: AgentDrivenWorkflowState
  let api: PlatformApi
  let regulatedBucket: string

  beforeAll(async () => {
    bootstrap = requireSpec(INDUSTRY, 'bootstrap')
    customDatasets = requireSpec(INDUSTRY, 'custom-datasets')
    interop = requireSpec(INDUSTRY, 'interoperability-contracts')
    createDac = requireSpec(INDUSTRY, 'create-dac')
    tools = requireSpec(INDUSTRY, 'tools')
    s = loadSpec(INDUSTRY, 'agent-driven-workflow') ?? emptyAgentDriven()

    if (!bootstrap.sarahSessionToken || !bootstrap.tenantSlug || !bootstrap.datalakeSlug || !bootstrap.datalakeId) {
      throw new Error('bootstrap.state.json incomplete — sarahSessionToken/tenantSlug/datalakeSlug/datalakeId missing')
    }
    if (!customDatasets.contactUsTableId) {
      throw new Error('custom-datasets.state.json missing contactUsTableId — run custom-datasets first')
    }
    if (!interop.contactUsContractId) {
      throw new Error('interoperability-contracts.state.json missing contactUsContractId')
    }
    if (!createDac.contactUsDacSlug) {
      throw new Error('create-dac.state.json missing contactUsDacSlug')
    }
    if (!tools.smsToolId) {
      throw new Error('tools.state.json missing smsToolId')
    }

    api = buildApi(bootstrap.sarahSessionToken)
    apiSessionToken = bootstrap.sarahSessionToken

    // The negative-branch error.json downloads need the regulated bucket
    // name. GenericTableResponse / DatalakeResponse expose
    // `regulated_cloud_storage` as a polymorphic embed; the embed object
    // carries `bucket` regardless of backend (R2, AWS, Custom).
    const { data: datalake } = await api.datalakes.get(bootstrap.tenantSlug!, bootstrap.datalakeId!)
    const cloudStorage = (datalake.regulated_cloud_storage ?? {}) as { bucket?: string }
    if (!cloudStorage.bucket) {
      throw new Error('datalake.regulated_cloud_storage.bucket missing — cannot download per-step artifacts')
    }
    regulatedBucket = cloudStorage.bucket
  })

  // ─── §1 create LLM tool wired to Ollama ──────────────────────────────────
  it('§1 create LLM tool (Ollama happy URL)', async (ctx) => {
    if (s.llmToolId) {
      ctx.skip()
      return
    }

    // Recovery path: a previous run may have created the tool server-side
    // but failed to persist the id (e.g., SDK response validation hiccup).
    // Look it up by name first so we don't try to create a duplicate and
    // hit the unique-(name, datalake_id) constraint.
    const existing = await findToolByName(api, bootstrap.tenantSlug!, LLM_TOOL_NAME)
    if (existing) {
      s.llmToolId = existing.id ?? null
      saveSpec(INDUSTRY, 'agent-driven-workflow', s)
      ctx.skip()
      return
    }

    const data = await rawPost<{ id: string; intent: string }>(
      `/api/v1/tenants/${bootstrap.tenantSlug}/tools`,
      {
        name: LLM_TOOL_NAME,
        description: 'OpenAI-compatible chat completion against local Ollama for AI agent enrichment',
        intent: 'chat_completion',
        status: 'active',
        datalake_id: bootstrap.datalakeId,
        body: {
          // Ollama ignores auth headers, but the platform's REST API tool
          // schema requires a non-`none` auth_method to match its
          // discriminated union variant. `api_key` with a stub value works —
          // the header is sent and Ollama discards it.
          tool_body_type: 'rest_api',
          base_url: OLLAMA_BASE,
          auth_method: 'api_key',
          api_key: 'ollama-noop',
          api_key_name: 'Authorization',
          api_key_location: 'header',
          request_type: 'json',
          response_type: 'json',
          timeout_ms: 60_000,
        },
      },
    )

    expect(data.id).toMatch(UUID_RE)
    expect(data.intent).toBe('chat_completion')
    s.llmToolId = data.id
    saveSpec(INDUSTRY, 'agent-driven-workflow', s)
  })

  // ─── §2 create LLM tool with deliberate bad URL (for transport branch) ───
  it('§2 create LLM tool with bad Ollama URL', async (ctx) => {
    if (s.llmToolFailingId) {
      ctx.skip()
      return
    }

    const existing = await findToolByName(api, bootstrap.tenantSlug!, LLM_TOOL_FAILING_NAME)
    if (existing) {
      s.llmToolFailingId = existing.id ?? null
      saveSpec(INDUSTRY, 'agent-driven-workflow', s)
      ctx.skip()
      return
    }

    const data = await rawPost<{ id: string }>(
      `/api/v1/tenants/${bootstrap.tenantSlug}/tools`,
      {
        name: LLM_TOOL_FAILING_NAME,
        description: 'Misconfigured chat completion — drives the tool_execution_failed branch',
        intent: 'chat_completion',
        status: 'active',
        datalake_id: bootstrap.datalakeId,
        body: {
          tool_body_type: 'rest_api',
          base_url: OLLAMA_BAD_PATH,
          auth_method: 'api_key',
          api_key: 'ollama-noop',
          api_key_name: 'Authorization',
          api_key_location: 'header',
          request_type: 'json',
          response_type: 'json',
          timeout_ms: 5_000,
        },
      },
    )

    expect(data.id).toMatch(UUID_RE)
    s.llmToolFailingId = data.id
    saveSpec(INDUSTRY, 'agent-driven-workflow', s)
  })

  // ─── §3 create the triage AI agent ───────────────────────────────────────
  it('§3 create Contact Us triage AI agent', async (ctx) => {
    if (s.agentId) {
      ctx.skip()
      return
    }
    if (!s.llmToolId) throw new Error('§1 must succeed first')

    const data = await rawPost<{ id: string; slug: string }>(
      `/api/v1/tenants/${bootstrap.tenantSlug}/datalakes/${bootstrap.datalakeSlug}/ai-agents`,
      {
        name: AGENT_NAME,
        tool_id: s.llmToolId,
        model: config.ollamaModel,
        data_access: 'unregulated',
        temperature: 0.0,
        max_tokens: 2048,
        enabled: true,
        input_schema: TRIAGE_INPUT_SCHEMA,
        llm_response_schema: TRIAGE_RESPONSE_SCHEMA,
        prompt_config: { type: 'custom', body: AGENT_PROMPT_BODY },
      },
    )

    expect(data.id).toMatch(UUID_RE)
    expect(data.slug).toBeTruthy()
    s.agentId = data.id
    s.agentSlug = data.slug
    saveSpec(INDUSTRY, 'agent-driven-workflow', s)
  })

  // ─── §4 create the positive Contact Us Triage workflow ───────────────────
  // Three SMS actions, one per decision_key. Agent's full mapping. Filter
  // is permissive (always true) so every ingested submission feeds into
  // enrichment.
  it('§4 create positive triage workflow', async (ctx) => {
    if (s.workflowPosId) {
      ctx.skip()
      return
    }
    if (!s.agentId || !s.agentSlug) throw new Error('§3 must succeed first')

    const data = await rawPost<{ id: string; slug: string; actions: Array<unknown> }>(
      `/api/v1/tenants/${bootstrap.tenantSlug}/datalakes/${bootstrap.datalakeSlug}/agentic-workflows`,
      {
        name: WORKFLOW_POS_NAME,
        description: 'Triages Contact Us submissions via Ollama into one of three SMS branches',
        dataset_type: 'generic_table',
        generic_table_id: customDatasets.contactUsTableId,
        skip_mdm_resolution: true,
        status: 'live',
        filter_config: { type: 'custom', body: 'true', output_schema: '{"type":"boolean"}' },
        decision_config: {
          type: 'custom',
          body: DECISION_CONFIG_BODY(s.agentSlug),
          output_schema: DECISION_OUTPUT_SCHEMA,
        },
        ai_agents: [
          {
            ai_agent_id: s.agentId,
            position: 0,
            context_mapping_config: {
              type: 'custom',
              body: FULL_MAPPING_BODY,
              output_schema: '{"type":"object"}',
            },
          },
        ],
        actions: [
          smsAction(DECISION_APPOINTMENT, tools.smsToolId!),
          smsAction(DECISION_JOB, tools.smsToolId!),
          smsAction(DECISION_SPAM, tools.smsToolId!),
        ],
      },
    )

    expect(data.id).toMatch(UUID_RE)
    expect(data.actions).toHaveLength(3)
    s.workflowPosId = data.id
    s.workflowPosSlug = data.slug
    saveSpec(INDUSTRY, 'agent-driven-workflow', s)
  })

  // ─── §5 create the bad-LLM-URL workflow (drives :tool_execution_failed) ──
  it('§5 create bad-LLM-URL workflow (negative)', async (ctx) => {
    if (s.workflowTransportId) {
      ctx.skip()
      return
    }
    if (!s.agentId || !s.agentSlug || !s.llmToolFailingId) {
      throw new Error('§2 and §3 must succeed first')
    }

    // Build a separate AI agent bound to the failing LLM tool. Both agents
    // share input_schema/prompt — only the underlying tool differs.
    const failingAgent = await rawPost<{ id: string; slug: string }>(
      `/api/v1/tenants/${bootstrap.tenantSlug}/datalakes/${bootstrap.datalakeSlug}/ai-agents`,
      {
        name: `${AGENT_NAME} — Bad Tool`,
        tool_id: s.llmToolFailingId,
        model: config.ollamaModel,
        data_access: 'unregulated',
        temperature: 0.0,
        max_tokens: 2048,
        enabled: true,
        input_schema: TRIAGE_INPUT_SCHEMA,
        llm_response_schema: TRIAGE_RESPONSE_SCHEMA,
        prompt_config: { type: 'custom', body: AGENT_PROMPT_BODY },
      },
    )

    const data = await rawPost<{ id: string; slug: string }>(
      `/api/v1/tenants/${bootstrap.tenantSlug}/datalakes/${bootstrap.datalakeSlug}/agentic-workflows`,
      {
        name: WORKFLOW_TRANSPORT_NAME,
        description: 'Wires LLM tool to a bad URL → tool_execution_failed surfaces on the WEL',
        dataset_type: 'generic_table',
        generic_table_id: customDatasets.contactUsTableId,
        skip_mdm_resolution: true,
        status: 'live',
        filter_config: { type: 'custom', body: 'true', output_schema: '{"type":"boolean"}' },
        decision_config: {
          type: 'custom',
          body: `["${DECISION_APPOINTMENT}"]`,
          output_schema: DECISION_OUTPUT_SCHEMA,
        },
        ai_agents: [
          {
            ai_agent_id: failingAgent.id,
            position: 0,
            context_mapping_config: {
              type: 'custom',
              body: FULL_MAPPING_BODY,
              output_schema: '{"type":"object"}',
            },
          },
        ],
        actions: [smsAction(DECISION_APPOINTMENT, tools.smsToolId!)],
      },
    )

    expect(data.id).toMatch(UUID_RE)
    s.workflowTransportId = data.id
    s.workflowTransportSlug = data.slug
    saveSpec(INDUSTRY, 'agent-driven-workflow', s)
  })

  // ─── §6 ingest 3 submissions through the Contact Us DAC ──────────────────
  // Every run is independent: submission_ids are namespaced by run-suffix,
  // so reruns against the same runId don't dedupe via the GT's unique
  // index on `submission_id`.
  // submission_id values are run-suffixed and shared between §7 (positive
  // run over all three) and §8 (negative run on one) — pinned in module
  // scope so the where clause for the negative can reuse the trio without
  // re-ingesting.
  let runSuffix: string
  let submissionIds: { appointment: string; job: string; spam: string }

  it('§6 ingest 3 submissions via Contact Us DAC', { timeout: 120_000 }, async () => {
    runSuffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
    submissionIds = {
      appointment: `SUB-APPT-${runSuffix}`,
      job: `SUB-JOB-${runSuffix}`,
      spam: `SUB-SPAM-${runSuffix}`,
    }

    const ingest = (subId: string, row: typeof SUBMISSION_APPOINTMENT) =>
      api.dataActivationClients.ingest(
        bootstrap.tenantSlug!,
        bootstrap.datalakeSlug!,
        createDac.contactUsDacSlug!,
        { data: { submission_id: subId, ...row } },
      )

    const results = await Promise.all([
      ingest(submissionIds.appointment, SUBMISSION_APPOINTMENT),
      ingest(submissionIds.job, SUBMISSION_JOB),
      ingest(submissionIds.spam, SUBMISSION_SPAM),
    ])

    // Each ingest gets its OWN batch_id (the DAC creates a fresh batch per
    // sync ingest call). Pin all three so we can pass them through the
    // workflow's sql_where_clause as an `IN (...)` list. lastBatchId is
    // kept as the first one for diagnostic purposes only.
    const batchIds = results.map((r) => r.data.batch_id).filter((b): b is string => !!b)
    expect(batchIds.length).toBe(3)
    s.lastBatchId = batchIds[0]!
    saveSpec(INDUSTRY, 'agent-driven-workflow', s)

    // Poll the DAC log listing until all three rows show rows_ingested > 0.
    // The Contact Us DAC has only one contract (the identity GT contract),
    // so each ingest produces exactly one log row.
    const deadline = Date.now() + 90_000
    let ourLogs: Array<Record<string, unknown>> = []
    while (Date.now() < deadline) {
      const { data } = await api.dataActivationClients.logs.list(
        bootstrap.tenantSlug!,
        bootstrap.datalakeSlug!,
        createDac.contactUsDacSlug!,
      )
      ourLogs = (data.data ?? [])
        .map((r) => r as Record<string, unknown>)
        .filter((r) => batchIds.includes(r.batch_id as string))

      const ingested = ourLogs.filter((r) => Number(r.rows_ingested ?? 0) > 0)
      if (ingested.length >= 3) break

      await new Promise((r) => setTimeout(r, 2_000))
    }

    expect(ourLogs.length).toBeGreaterThanOrEqual(3)
  })

  // ─── §7 run positive workflow → 3 WELs all completed ─────────────────────
  it(
    '§7 run positive workflow, 3 WELs all complete with one matching AEL each',
    { timeout: OLLAMA_RUN_TIMEOUT_MS },
    async () => {
      if (!s.workflowPosSlug) throw new Error('§4 must succeed first')

      // Pin the where-clause to THIS run's three submission_ids so reruns
      // don't pick up rows from prior runs still living in the GT. Using
      // submission_id (the GT's unique column) is more direct than
      // chasing the per-ingest batch_id IN (...) list.
      const ids = [submissionIds.appointment, submissionIds.job, submissionIds.spam]
        .map((id) => `'${id}'`)
        .join(', ')

      const { data: runResp } = await api.workflows.run(bootstrap.tenantSlug!, s.workflowPosSlug, {
        sql_where_clause: `submission_id IN (${ids})`,
        mode: 'live',
        manual_override: true,
      })

      expect(runResp.workflow_run_log_id).toMatch(UUID_RE)
      expect(runResp.enqueued_count).toBe(3)
      const batchId = runResp.batch_id!

      await pollBatchTerminal(api, bootstrap.tenantSlug!, s.workflowPosSlug, runResp.workflow_run_log_id!)

      const { data: logs } = await api.workflows.workflowLogs.list(bootstrap.tenantSlug!, s.workflowPosSlug)
      const wels = (logs.data ?? []).filter((w) => (w as { batch_id?: string }).batch_id === batchId)
      expect(wels.length).toBe(3)

      const failed = wels.filter((w) => w.status === 'failed')
      expect(failed).toHaveLength(0)

      // Each WEL has 3 AELs, one per decision_key. Exactly one should be
      // "pending" (the one matching the LLM-returned category) and two
      // "skipped" (the unmatched siblings).
      for (const wel of wels) {
        expect(wel.actions_total).toBe(3)
        // pending + completed (action scheduling done) — matched action
        // is :pending until the per-AEL Oban worker runs; in dev mode the
        // worker may already have fired, so accept either count layout.
        expect((wel.actions_pending ?? 0) + (wel.actions_completed ?? 0)).toBeGreaterThanOrEqual(1)
      }

      // Per-step artifact round-trip (gaps E, F-pass, G). Pick the first
      // WEL — the assertions are shape-checks on each artifact; covering
      // one of the three is sufficient for branch coverage of the three
      // upload sites in agentic_workflows.ex.
      const sampleWel = wels[0] as { id?: string; workflow_id?: string }
      expect(sampleWel.id).toBeTruthy()

      // event.json — full WorkflowContext snapshot; submission_id from the
      // GT row should round-trip into event_dataset.
      const eventJson = await fetchArtifact<EventJson>(api, bootstrap, regulatedBucket, sampleWel, 'event')
      expect(eventJson.event_dataset).toBeTypeOf('object')
      expect(eventJson.event_dataset!.submission_id).toBeTypeOf('string')

      // filter.json — pass branch carries filter_expression + filter_result: true.
      const filterJson = await fetchArtifact<FilterJson>(api, bootstrap, regulatedBucket, sampleWel, 'filter')
      expect(filterJson.filter_expression).toBe('true')
      expect(filterJson.filter_result).toBe(true)

      // enrichment.json — has-agents success branch: status: completed,
      // plus a per-agent entry keyed by slug carrying the parsed LLM output.
      const enrichmentJson = await fetchArtifact<EnrichmentJson>(api, bootstrap, regulatedBucket, sampleWel, 'enrichment')
      expect(enrichmentJson.status).toBe('completed')
      const agentSlug = s.agentSlug!
      const agentEntry = enrichmentJson[agentSlug] as { status: string; output?: { category?: string } } | undefined
      expect(agentEntry).toBeDefined()
      expect(agentEntry!.status).toBe('completed')
      expect(agentEntry!.output?.category).toMatch(/^(appointment_request|job_inquiry|flag_spam)$/)
    },
  )

  // ─── §8 run bad-LLM-URL workflow → :failed, error.json :tool_execution_failed
  it(
    '§8 run bad-LLM-URL workflow → error.json carries tool_execution_failed',
    { timeout: 60_000 },
    async () => {
      if (!s.workflowTransportSlug) throw new Error('§5 must succeed first')

      // The transport failure happens INSIDE the LLM tool call, so the row
      // content is irrelevant — any populated row exercises it identically.
      // Using `1=1` keeps this section independently runnable (no dependency
      // on §6's runtime-set `submissionIds`); each row produces a uniformly
      // shaped failed WEL, the test asserts on the first one it finds.
      const { data: runResp } = await api.workflows.run(
        bootstrap.tenantSlug!,
        s.workflowTransportSlug,
        {
          sql_where_clause: '1=1',
          mode: 'live',
          manual_override: true,
        },
      )

      await pollBatchTerminal(api, bootstrap.tenantSlug!, s.workflowTransportSlug, runResp.workflow_run_log_id!)

      const { data: logs } = await api.workflows.workflowLogs.list(bootstrap.tenantSlug!, s.workflowTransportSlug)
      const ourWels = (logs.data ?? []).filter((w) => (w as { batch_id?: string }).batch_id === runResp.batch_id)
      expect(ourWels.length).toBeGreaterThan(0)
      const failedWel = ourWels.find((w) => w.status === 'failed')
      expect(failedWel).toBeDefined()

      const errorJson = await fetchArtifact<ErrorJson>(api, bootstrap, regulatedBucket, failedWel!, 'error')
      expect(errorJson.error_code).toBe('tool_execution_failed')
      expect(errorJson.stage).toBe('enrichment')

      // Gap B — error.json carries the failing agent's slug. Both agents
      // share the same triage prompt; only the underlying tool differs.
      // The failing agent created in §5 has name "${AGENT_NAME} — Bad Tool".
      // We didn't capture its slug into state, so just assert presence
      // and shape rather than equality.
      expect(errorJson.ai_agent_slug).toBeTypeOf('string')
      expect(errorJson.ai_agent_slug).toMatch(/contact-us-triage-categorizer-bad-tool/)

      // Gap C — code-grade error_message format. Driven by the literal
      // `"AI enrichment failed: <agent_name>"` template at
      // [agentic_workflows.ex:2436](lib/platform/agentic_workflows.ex#L2436).
      expect(errorJson.error_message).toBe(`AI enrichment failed: ${AGENT_NAME} — Bad Tool`)

      // Gap D + J — rich detail surface. The bad-URL tool drives the
      // RESTAPI processor's `parse_error_response/1`; the resulting
      // `{:http_*, status, "HTTP <s> (<body>) at <url>"}` tuple is
      // collapsed into a single string `detail` carried ONLY in
      // error.json (NOT WEL.error_message). This is the load-bearing
      // assertion that proves the WEL/error.json split is wired
      // correctly — without it, the rich URL/status/transport context
      // could silently regress into the DB column.
      expect(errorJson.detail).toBeTypeOf('string')
      // The bad path is `/wrong-path/that/does/not/exist`, which Ollama
      // 404s. The platform appends `/chat/completions` so the URL in
      // detail ends `/wrong-path/that/does/not/exist/chat/completions`.
      expect(errorJson.detail).toMatch(/wrong-path/)
      // The detail should mention HTTP status (Ollama returns 404 here)
      // OR transport-error wording when the URL doesn't even resolve.
      expect(errorJson.detail).toMatch(/HTTP \d{3}|transport error/)
    },
  )

  // ─── §9 negative POST /ai-agents missing llm_response_schema → 422 ─────
  // Stage 2 made llm_response_schema a required field on the AiAgent
  // changeset (lib/platform/ai_agents/ai_agent.ex). The OpenAPI spec
  // mirrors this in the AiAgentRequest schema's `required:` list.
  // Vitest must guard the contract: omitting the field at the wire layer
  // returns 422 with the validation error pointing at llm_response_schema.
  // SDK valibot validation enforces this client-side too, so we use raw
  // fetch to actually send an invalid body and observe the server's 422.
  it('§9 POST /ai-agents missing llm_response_schema → 422', async () => {
    if (!s.llmToolId) throw new Error('§1 must succeed first')

    const resp = await fetch(
      `${config.baseUrl}/api/v1/tenants/${bootstrap.tenantSlug}/datalakes/${bootstrap.datalakeSlug}/ai-agents`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiSessionToken}`,
        },
        body: JSON.stringify({
          name: `Negative Schema Agent ${Date.now()}`,
          tool_id: s.llmToolId,
          model: config.ollamaModel,
          data_access: 'unregulated',
          temperature: 0.0,
          max_tokens: 2048,
          enabled: true,
          input_schema: TRIAGE_INPUT_SCHEMA,
          // NOTE: llm_response_schema deliberately omitted.
          prompt_config: { type: 'custom', body: AGENT_PROMPT_BODY },
        }),
      },
    )

    expect(resp.status).toBe(422)
    const json = (await resp.json()) as { errors?: Record<string, unknown> }
    expect(json.errors).toBeDefined()
    // The Ecto changeset error key is `llm_response_schema`; OpenApiSpex
    // wraps it but preserves the field name in the error map.
    const errorsStr = JSON.stringify(json.errors)
    expect(errorsStr).toContain('llm_response_schema')
  })

  // ─── §10 PUT /ai-agents/:id round-trip (replace semantics) ─────────────
  // Replace-on-PUT means the full body must be sent — a partial PUT would
  // drop other required fields. Asserts the changeset accepts the round-
  // trip and the GET reflects the new value. Path param is :id (UUID),
  // NOT slug — confirmed in lib/platform_api/routes.ex.
  it('§10 PUT /ai-agents/:id round-trip', async () => {
    if (!s.agentId || !s.agentSlug || !s.llmToolId) throw new Error('§3 must succeed first')

    const newDescription = `Updated description ${Date.now()}`
    const updated = await rawPut<{ id: string; description?: string }>(
      `/api/v1/tenants/${bootstrap.tenantSlug}/datalakes/${bootstrap.datalakeSlug}/ai-agents/${s.agentId}`,
      {
        name: AGENT_NAME,
        description: newDescription,
        tool_id: s.llmToolId,
        model: config.ollamaModel,
        data_access: 'unregulated',
        temperature: 0.0,
        max_tokens: 2048,
        enabled: true,
        input_schema: TRIAGE_INPUT_SCHEMA,
        llm_response_schema: TRIAGE_RESPONSE_SCHEMA,
        prompt_config: { type: 'custom', body: AGENT_PROMPT_BODY },
      },
    )

    expect(updated.id).toBe(s.agentId)
    expect(updated.description).toBe(newDescription)
  })

  // ─── §11 LIST + GET-by-id for ai-agents ────────────────────────────────
  // Smoke test on the read paths: the agent created in §3 must appear in
  // the LIST response and be fetchable by id (UUID — the SHOW route is
  // `/ai-agents/:id`, slug is not a routing key).
  it('§11 LIST + GET ai-agent by id', async () => {
    if (!s.agentId || !s.agentSlug) throw new Error('§3 must succeed first')

    const listResp = await fetch(
      `${config.baseUrl}/api/v1/tenants/${bootstrap.tenantSlug}/datalakes/${bootstrap.datalakeSlug}/ai-agents`,
      { headers: { Authorization: `Bearer ${apiSessionToken}` } },
    )
    expect(listResp.ok).toBe(true)
    const list = (await listResp.json()) as { data?: Array<{ id?: string; slug?: string }> }
    const found = (list.data ?? []).find((a) => a.id === s.agentId)
    expect(found).toBeDefined()
    expect(found!.slug).toBe(s.agentSlug)

    const getResp = await fetch(
      `${config.baseUrl}/api/v1/tenants/${bootstrap.tenantSlug}/datalakes/${bootstrap.datalakeSlug}/ai-agents/${s.agentId}`,
      { headers: { Authorization: `Bearer ${apiSessionToken}` } },
    )
    expect(getResp.ok).toBe(true)
    const got = (await getResp.json()) as { id?: string; slug?: string; name?: string }
    expect(got.id).toBe(s.agentId)
    expect(got.slug).toBe(s.agentSlug)
    expect(got.name).toBe(AGENT_NAME)
  })
})

// ─── helpers ────────────────────────────────────────────────────────────────

// Recovery hatch for cases where a prior run created the resource server-side
// but failed to persist the id locally. We bypass the SDK list because the
// SDK's valibot response schema for the polymorphic `body` discriminated union
// can fail to validate fully-populated server responses (the server returns
// every field of every variant, which is a superset the SDK schema may not
// accept). Raw fetch + read `id`+`name` is sufficient — the existence check
// doesn't need the full schema.
async function findToolByName(
  _api: PlatformApi,
  tenantSlug: string,
  name: string,
): Promise<{ id?: string } | null> {
  const resp = await fetch(
    `${config.baseUrl}/api/v1/tenants/${tenantSlug}/tools`,
    { headers: { Authorization: `Bearer ${apiSessionToken}` } },
  )
  if (!resp.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[findToolByName] HTTP ${resp.status} listing tools — skipping recovery`)
    return null
  }
  const json = (await resp.json()) as { data?: Array<{ id?: string; name?: string }> }
  const found = (json.data ?? []).find((t) => t.name === name)
  if (!found) {
    // eslint-disable-next-line no-console
    console.warn(
      `[findToolByName] no tool named "${name}" — got [${(json.data ?? [])
        .map((t) => t.name)
        .join(', ')}]`,
    )
  }
  return found ?? null
}

// Raw POST helper. The SDK's valibot response validation fails on
// polymorphic discriminated unions (chat_completion tool body, GT-bound
// workflow body, etc.) when the server returns a superset of fields
// across variants. Bypassing the SDK lets us round-trip the actual
// server response without the validator's narrow schema rejecting it.
//
// Throws on non-2xx with the server's JSON error attached for clarity.
async function rawPost<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiSessionToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`POST ${path} → ${resp.status} ${resp.statusText}: ${text}`)
  }
  return (await resp.json()) as T
}

// Raw PUT — same rationale as `rawPost`. Used by §10 to round-trip the
// AiAgent UPDATE without the SDK's response validator narrowing the body.
async function rawPut<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${config.baseUrl}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiSessionToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`PUT ${path} → ${resp.status} ${resp.statusText}: ${text}`)
  }
  return (await resp.json()) as T
}

async function pollBatchTerminal(
  api: PlatformApi,
  tenantSlug: string,
  workflowSlug: string,
  workflowRunLogId: string,
) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const { data: log } = await api.workflows.batchLogs.refresh(tenantSlug, workflowSlug, workflowRunLogId)
    if (log.status && log.status !== 'pending') return log
    await new Promise((r) => setTimeout(r, 2_000))
  }
  throw new Error(`WorkflowRunLog ${workflowRunLogId} did not leave :pending within 180s`)
}

// Round-trip a per-step JSON artifact. The platform's `upload_wel_step_artifact/4`
// writes to `workflows/<wf_id>/executions/<wel_id>/<step>.json` in the regulated
// bucket; clients fetch via the standard datalake download-link endpoint. In
// dev mode the upload runs synchronously through `BackgroundTask.run/1` so by
// the time `pollBatchTerminal` returns, the file is on disk.
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

type ErrorJson = {
  error_code: string
  stage: string
  ai_agent_slug?: string
  error_message?: string
  detail?: string | null
}

type FilterJson = {
  filter_expression: string
  filter_result: boolean
}

type EnrichmentJson = {
  status: 'completed' | 'failed' | 'skipped'
  [agentSlug: string]: unknown
}

type EventJson = {
  event_dataset?: Record<string, unknown>
  mdm_output?: Record<string, unknown>
  additional_context?: Record<string, unknown>
}
