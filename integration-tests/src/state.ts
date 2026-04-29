/**
 * Vitest E2E state — disk layout and access primitives.
 *
 *   vitest-state/<industry>/
 *     base.state.json          ← written ONCE by state-create; names + creds
 *     current.txt              ← written by state-create; active runId
 *     <runId>/
 *       <spec>.state.json      ← written by spec <spec>.test.ts only
 *
 * Rules of the road:
 *   1. `base.state.json` is INPUT-ONLY for tests — never mutated after
 *      state-create runs. Holds derived names (sarahEmail, tenantName …)
 *      and credentials. Lives at industry level so state-create can
 *      overwrite it on every run while preserving prior runId subdirs.
 *
 *   2. `current.txt` is a 1-line pointer ("1777295376795\n") naming the
 *      active runId. Tests read it once at module load. Lets state-create
 *      generate a new runId without us hunting for "the latest" by mtime.
 *
 *   3. Each spec writes ONE state file under <runId>/, named after itself.
 *      Spec 01-bootstrap → bootstrap.state.json. The number prefix on the
 *      test file is for vitest ordering only; the state file is slug-only.
 *
 *   4. Downstream specs READ prior specs' state files, MERGE in memory,
 *      WRITE only their own slice. They never edit base or another spec's
 *      file.
 *
 *   5. Old runId subdirs are kept on disk — they're an audit trail. To wipe
 *      everything for an industry, run `pnpm state:clear:<industry>`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_ROOT = resolve(__dirname, '../vitest-state')

// ───────────────────────────── industries ──────────────────────────────────

export type Industry = 'healthcare' | 'accounts_receivable' | 'payment_risk'

export const INDUSTRIES: readonly Industry[] = [
  'healthcare',
  'accounts_receivable',
  'payment_risk',
] as const

// ───────────────────────────── state shapes ────────────────────────────────
//
// Each spec owns a narrow type. `MergedState` is the intersection — that's
// what specs see after merging prior files. Splitting them this way means
// TypeScript catches "spec 03 wrote a key that belongs to spec 01" at the
// saveSpec() call site, not at runtime.
//
// All "produced by tests" fields are nullable because earlier specs may not
// have run yet (cold rerun, partial state from a prior aborted run).

export interface BaseState {
  runId: string
  industry: Industry

  // Account credentials (state-create derives these from runId + dev.env)
  sarahEmail: string
  sarahPassword: string
  tenantName: string
  datalakeName: string
  emmaEmail: string
  jamesEmail: string

  // Resource names — fixed per industry, scoped to the tenant
  dataSourceName: string
  interopTemplateName: string
  dacName: string
  cloudWatchToolName: string
  snsToolName: string
  lambdaToolName: string
  updaterName: string
}

export interface BootstrapState {
  rootBearer: string | null
  sarahUserId: string | null
  sarahTenantlessBearer: string | null
  tenantId: string | null
  tenantSlug: string | null
  sarahSessionToken: string | null
  datalakeId: string | null
  datalakeSlug: string | null
}

export interface InviteTeamState {
  emmaUserId: string | null
  emmaTenantlessBearer: string | null
  emmaSessionToken: string | null
  jamesUserId: string | null
  jamesTenantlessBearer: string | null
  jamesSessionToken: string | null
}

export interface DataSourcesState {
  dataSourceId: string | null
}

export interface InteropContractsState {
  // System contract — references a built-in Liquid template by path
  systemContractId: string | null
  systemContractSlug: string | null
  // Custom contract — inline Liquid body
  customContractId: string | null
  customContractSlug: string | null
  // Auto-created identity contract for the Contact Us generic table.
  // The GT lifecycle (`Platform.GenericTables.setup_generic_table_interoperability/2`)
  // creates this on every GT insert with `template_config: {type: identity}` —
  // the spec just LOOKS IT UP and pins its id, it does not create one.
  contactUsContractId: string | null
  contactUsContractSlug: string | null
}

/**
 * Per-tool-variant IDs. tools.test.ts grows incrementally — manual_upload
 * lands first (DAC needs it), the other 10 variants follow in subsequent
 * batches. Each new variant adds a single nullable id to this interface;
 * specs that reference a tool look up its id by variant name.
 */
export interface ToolsState {
  manualUploadToolId: string | null
  smsToolId: string | null
  smsToolFailingId: string | null
}

export interface CreateDacState {
  dacId: string | null
  dacSlug: string | null
  // Contact Us GT DAC — separate DAC dedicated to ingesting rows into the
  // Contact Us generic table. Reuses the manual_upload tool from
  // tools.state.json and binds the auto-created identity interop contract
  // pinned by interoperability-contracts.state.json.contactUsContractId.
  contactUsDacId: string | null
  contactUsDacSlug: string | null
}

/**
 * run-dac-single — single-row JSON ingest via POST /ingest. The batch_id
 * comes back synchronously in the ingest response; we save it so downstream
 * dataset-search assertions can pin to this specific batch.
 */
export interface RunDacSingleState {
  lastBatchId: string | null
}

/**
 * run-dac-bulk — full-CSV ingest via the three-step file-upload path:
 *   1. POST /datalakes/:slug/upload-link → { url, key }
 *   2. PUT <url> with raw CSV body → S3 (no return value of interest)
 *   3. POST /data-activation-clients/:slug/ingest-file { key }
 *        → { job_id, key, status }
 *
 * Unlike single ingest, ingest-file does NOT return a batch_id — the
 * batch_id is generated server-side inside the Oban job. We discover it
 * by polling the DAC log listing for log rows whose `inserted_at` is
 * newer than our pre-ingest snapshot, then taking the batch_id off the
 * new rows.
 */
export interface RunDacBulkState {
  uploadKey: string | null
  ingestJobId: number | null
  detectedBatchId: string | null
}

/**
 * custom-datasets — generic-table CRUD via JSON API.
 *
 * Mirrors playwright-e2e/tests/custom-datasets.spec.ts §1b — creates the
 * "Contact Us Submissions" generic table that downstream specs (e.g.
 * agent-driven-workflow) hang their workflow off. The table is created
 * via `POST /datalakes/:slug/generic-tables`; the controller fires an
 * Oban DDL job, so the spec polls the listing until `status === 'deployed'`
 * before saving the id/slug/name.
 *
 * The HTTP create path returns the auto-generated `name` field
 * ("alvera_custom_contact_us_submissions") — that's the canonical key the
 * agent-driven workflow's `generic_table_id` resolves against, so it's
 * threaded as part of state for downstream lookups.
 *
 * `contactUsTableSlug` is included for symmetry with sibling spec states
 * (BootstrapState.datalakeSlug, CreateDacState.dacSlug, etc.) even though
 * GenericTable has no `slug` column — the auto-derived `name` plays that
 * role server-side, and `contactUsTableSlug` will currently always be null.
 * Keeping the field means the shape stays uniform and a future server-side
 * addition of a separate `slug` lands without a state-shape break.
 */
export interface CustomDatasetsState {
  contactUsTableId: string | null
  contactUsTableSlug: string | null
  contactUsTableName: string | null
}

/**
 * standard-workflow — appointment review SMS workflow + run.
 *
 * The "standard" workflow shape: filter → decision (literal liquid array) →
 * scheduled tool action. No AI agents, no enrichment. Sibling
 * `agent-driven-workflow` covers the LLM-enrichment variant.
 *
 * Anchors on the gold-reference scenario from
 *   test/platform/agentic_workflows/appointment_follow_up_sms_workflow_test.exs
 * (the "Review SMS" workflow). The vitest variant drops the recency window
 * filter (vitest has no DB write to bump appointment.start to "now") and
 * instead gates on source_uri match alone — so any CSV-ingested appointment
 * with the matching source_uri passes.
 *
 * Threading:
 *   READS:  bootstrap (tenantSlug, datalakeSlug, sarahSessionToken)
 *   READS:  tools (smsToolId)
 *   READS:  run-dac-bulk (detectedBatchId — for the live-fire single-appt run)
 *   WRITES: connectedAppId, workflowId, workflowSlug, lastWorkflowRunLogId
 */
/**
 * agent-driven-workflow — Contact Us Triage workflow with LLM enrichment.
 *
 * Sibling to `standard-workflow`. Same pipeline shape, different decision
 * source: enrichment AI agent runs over Ollama, its output drives the
 * decision_key, three SMS actions fan out, exactly one fires per WEL.
 *
 * Two branches:
 *   * positive — Ollama at the canonical chat-completion path categorises
 *                each row, all three WELs complete with the matching SMS
 *                action scheduled.
 *   * transport — a SECOND LLM tool wired to a wrong path on Ollama drives
 *                 the workflow to `tool_execution_failed`. Round-trips the
 *                 per-step error.json artifact via the datalake download-
 *                 link endpoint.
 *
 * Threading:
 *   READS:  bootstrap (tenantSlug, datalakeSlug, sarahSessionToken, datalakeId)
 *   READS:  custom-datasets (contactUsTableId, contactUsTableName)
 *   READS:  interoperability-contracts (contactUsContractId)
 *   READS:  create-dac (contactUsDacId, contactUsDacSlug)
 *   READS:  tools (smsToolId)
 *   WRITES: llmToolId, llmToolFailingId, agentId/Slug,
 *           workflowPosId/Slug (positive), workflowTransportId/Slug
 *           (negative — wrong-path LLM tool), lastBatchId.
 */
export interface AgentDrivenWorkflowState {
  llmToolId: string | null
  llmToolFailingId: string | null
  agentId: string | null
  agentSlug: string | null
  workflowPosId: string | null
  workflowPosSlug: string | null
  workflowTransportId: string | null
  workflowTransportSlug: string | null
  lastBatchId: string | null
}

export interface StandardWorkflowState {
  connectedAppId: string | null
  connectedAppSlug: string | null
  workflowId: string | null
  workflowSlug: string | null
  lastWorkflowRunLogId: string | null
  // §5 fresh-ingest state — threaded to §6 (execute + message assertion).
  // Each represents the unique-per-run row that the §5 ingest produced.
  freshIngestBatchId: string | null
  freshAppointmentId: string | null
}

/** Union of every per-spec state — narrows at saveSpec() via the spec name. */
export interface SpecStates {
  bootstrap: BootstrapState
  'invite-team': InviteTeamState
  'data-sources': DataSourcesState
  'interoperability-contracts': InteropContractsState
  tools: ToolsState
  'create-dac': CreateDacState
  'run-dac-single': RunDacSingleState
  'run-dac-bulk': RunDacBulkState
  'custom-datasets': CustomDatasetsState
  'standard-workflow': StandardWorkflowState
  'agent-driven-workflow': AgentDrivenWorkflowState
}

export type SpecName = keyof SpecStates

// ───────────────────────────── path helpers ────────────────────────────────

function industryDir(industry: Industry): string {
  return resolve(STATE_ROOT, industry)
}

function basePath(industry: Industry): string {
  return resolve(industryDir(industry), 'base.state.json')
}

function currentPointerPath(industry: Industry): string {
  return resolve(industryDir(industry), 'current.txt')
}

function runDir(industry: Industry, runId: string): string {
  return resolve(industryDir(industry), runId)
}

function specPath<S extends SpecName>(
  industry: Industry,
  runId: string,
  spec: S,
): string {
  return resolve(runDir(industry, runId), `${spec}.state.json`)
}

// ───────────────────────────── readers ─────────────────────────────────────

/**
 * Read the active runId from `<industry>/current.txt`. Throws if state-create
 * hasn't been run yet — by design, tests never invent a runId.
 */
export function readCurrentRunId(industry: Industry): string {
  const ptr = currentPointerPath(industry)
  if (!existsSync(ptr)) {
    throw new Error(
      `vitest-state/${industry}/current.txt not found.\n` +
        `Run \`pnpm state:create:${industry}\` first.`,
    )
  }
  const runId = readFileSync(ptr, 'utf8').trim()
  if (!runId) throw new Error(`current.txt is empty for industry ${industry}`)
  return runId
}

/**
 * Read base.state.json — names + credentials. Throws if state-create hasn't
 * run. This file is the only piece of state both state-create and tests
 * agree on; it never changes mid-run.
 */
export function loadBase(industry: Industry): BaseState {
  const path = basePath(industry)
  if (!existsSync(path)) {
    throw new Error(
      `vitest-state/${industry}/base.state.json not found.\n` +
        `Run \`pnpm state:create:${industry}\` first.`,
    )
  }
  return JSON.parse(readFileSync(path, 'utf8')) as BaseState
}

/**
 * Read a per-spec state file under the active runId. Returns `null` when the
 * spec hasn't run yet — the caller decides whether that's fatal (downstream
 * spec needs it) or fine (the spec itself reading its own prior output for
 * rerun short-circuit).
 */
export function loadSpec<S extends SpecName>(
  industry: Industry,
  spec: S,
): SpecStates[S] | null {
  const runId = readCurrentRunId(industry)
  const path = specPath(industry, runId, spec)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as SpecStates[S]
}

/**
 * Read a per-spec state file and throw if absent. Use this when a downstream
 * spec strictly requires an upstream spec's output (e.g. 02-invite-team
 * cannot proceed without 01-bootstrap's tenantSlug).
 */
export function requireSpec<S extends SpecName>(
  industry: Industry,
  spec: S,
): SpecStates[S] {
  const found = loadSpec(industry, spec)
  if (!found) {
    throw new Error(
      `Required upstream state ${spec}.state.json not found for industry ${industry} ` +
        `(runId=${readCurrentRunId(industry)}). Run that spec first.`,
    )
  }
  return found
}

// ───────────────────────────── writer ──────────────────────────────────────

/**
 * Write a per-spec state file under the active runId. The spec name ties
 * the file to the writer; TypeScript narrows the partial to that spec's
 * shape, preventing cross-contamination at compile time.
 *
 * Idempotent: callers typically pass the FULL current state object (not a
 * delta) and we replace the file each call.
 */
export function saveSpec<S extends SpecName>(
  industry: Industry,
  spec: S,
  state: SpecStates[S],
): void {
  const runId = readCurrentRunId(industry)
  const dir = runDir(industry, runId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(specPath(industry, runId, spec), JSON.stringify(state, null, 2))
}

// ───────────────────────────── audit / debug ───────────────────────────────

/** List every runId subdir for an industry, newest first by name (lexicographic on Date.now()). */
export function listRunIds(industry: Industry): string[] {
  const dir = industryDir(industry)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()
}
