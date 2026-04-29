/**
 * custom-datasets — generic-table CRUD via JSON API.
 *
 * Mirrors playwright-e2e/tests/custom-datasets.spec.ts §1b — creates the
 * "Contact Us Submissions" generic table that downstream specs (e.g.
 * agent-driven-workflow) attach their workflow to.
 *
 * Generic table creation is two-phase:
 *   1. POST /datalakes/:slug/generic-tables — creates the row, fires an
 *      Oban DDL job, returns immediately with `status: 'new'` (or
 *      'processing' if the worker has already picked it up).
 *   2. The DDL worker creates the physical Postgres table and flips the
 *      row to `status: 'deployed'`.
 *
 * The SDK doesn't expose `genericTables.get`, so this spec polls
 * `genericTables.list` until our row reports `status === 'deployed'`
 * before persisting state. Downstream specs assume `status === 'deployed'`
 * is invariant by the time they boot.
 *
 * State files this spec touches:
 *   READS:  base.state.json
 *   READS:  <runId>/bootstrap.state.json   REQUIRED — tenantSlug, datalakeSlug
 *   READS:  <runId>/custom-datasets.state.json   own prior output (rerun)
 *   WRITES: <runId>/custom-datasets.state.json   contactUsTableId/Slug/Name
 */
import { describe, beforeAll, expect, it } from 'vitest'
import type { GenericTableColumn, PlatformApi } from '@alvera-ai/platform-sdk'
import { buildApi } from '../../src/api'
import {
  type BaseState,
  type BootstrapState,
  type CustomDatasetsState,
  type Industry,
  loadBase,
  loadSpec,
  requireSpec,
  saveSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const CONTACT_US_TITLE = 'Contact Us Submissions'
// Server-derived from the title via Platform.GenericTables — slugified to
// snake_case and prefixed with `alvera_custom_`. Asserted, not configured.
const EXPECTED_NAME = 'alvera_custom_contact_us_submissions'

// Column shape mirrors the playwright spec § §1b form fields exactly: same
// names, types, privacy levels, and uniqueness constraints. Mismatching the
// `name` here would yield a different generated table and break downstream
// agent-driven workflow specs that rely on the canonical name.
const CONTACT_US_COLUMNS = [
  {
    name: 'submission_id',
    title: 'Submission ID',
    type: 'string',
    description: 'Unique submission identifier',
    is_unique: true,
    privacy_requirement: 'none',
  },
  {
    name: 'name',
    title: 'Name',
    type: 'string',
    description: 'Contact person name',
    is_unique: false,
    privacy_requirement: 'tokenize',
  },
  {
    name: 'email',
    title: 'Email',
    type: 'string',
    description: 'Contact email address',
    is_unique: false,
    privacy_requirement: 'tokenize',
  },
  {
    name: 'message',
    title: 'Message',
    type: 'string',
    description: 'Contact form message body',
    is_unique: false,
    privacy_requirement: 'redact_only',
  },
  {
    name: 'source_site',
    title: 'Source Site',
    type: 'string',
    description: 'Website origin of the submission',
    is_unique: false,
    privacy_requirement: 'none',
  },
] as const

// DDL pacing: the migrator runs synchronously per-table on a quiet dev
// box (~1s) but a busy one with the workflow queue saturated has been
// observed to push past 30s. Floor is generous; the loop exits on
// success so the floor is only paid in genuine failure mode.
const DEPLOY_TIMEOUT_MS = 60_000
const DEPLOY_POLL_MS = 1_000

function emptyCustomDatasets(): CustomDatasetsState {
  return {
    contactUsTableId: null,
    contactUsTableSlug: null,
    contactUsTableName: null,
  }
}

describe('healthcare/custom-datasets', () => {
  let base: BaseState
  let bootstrap: BootstrapState
  let s: CustomDatasetsState
  let api: PlatformApi

  beforeAll(() => {
    base = loadBase(INDUSTRY)
    bootstrap = requireSpec(INDUSTRY, 'bootstrap')
    s = loadSpec(INDUSTRY, 'custom-datasets') ?? emptyCustomDatasets()

    if (!bootstrap.sarahSessionToken || !bootstrap.tenantSlug || !bootstrap.datalakeSlug) {
      throw new Error('bootstrap.state.json incomplete — sarahSessionToken / tenantSlug / datalakeSlug missing')
    }
    api = buildApi(bootstrap.sarahSessionToken)
  })

  // ─── §1 list generic tables — fresh datalake returns paginated envelope ──
  it('§1 list generic tables returns paginated envelope', async () => {
    const { data } = await api.genericTables.list(bootstrap.tenantSlug!, bootstrap.datalakeSlug!)
    expect(Array.isArray(data.data)).toBe(true)
    expect(data.meta).toBeDefined()
  })

  // ─── §2 create the Contact Us Submissions generic table ──────────────────
  // Idempotent on rerun via the prior-state short-circuit. The actual create
  // is fast (HTTP-200 with a `:new` row); the WORK is the async DDL job that
  // builds the physical table — covered by §3 polling.
  it('§2 create Contact Us Submissions generic table', async (ctx) => {
    if (s.contactUsTableId) {
      ctx.skip()
      return
    }

    const { data } = await api.genericTables.create(bootstrap.tenantSlug!, bootstrap.datalakeSlug!, {
      title: CONTACT_US_TITLE,
      description: 'Contact form submissions from The Doctors Center website',
      columns: CONTACT_US_COLUMNS as readonly GenericTableColumn[] as GenericTableColumn[],
    })

    expect(data.id).toMatch(UUID_RE)
    expect(data.title).toBe(CONTACT_US_TITLE)
    // The auto-derived `name` is the canonical key downstream specs use to
    // resolve `generic_table_id` — assert it directly so a server-side
    // slugifier change blows up here, not three specs downstream.
    expect(data.name).toBe(EXPECTED_NAME)

    s.contactUsTableId = data.id ?? null
    // GenericTableResponse currently has no `slug` field — record whatever
    // the server returns (likely undefined → null) so the state shape stays
    // ready for a future server-side addition without a vitest churn.
    s.contactUsTableSlug = (data as { slug?: string | null }).slug ?? null
    s.contactUsTableName = data.name ?? null
    saveSpec(INDUSTRY, 'custom-datasets', s)
  })

  // ─── §3 wait for DDL deployment (status: deployed) ───────────────────────
  // Generic-table create fires an Oban DDL job that builds the physical
  // Postgres table and flips `status` from :new → :processing → :deployed.
  // The SDK has no `genericTables.get`, so we re-list and find by id each
  // poll iteration. Costlier than a get-by-id, but the listing is small
  // (~1 KB for a fresh datalake) and the poll runs at most ~60×.
  it('§3 generic table reaches :deployed status', async () => {
    if (!s.contactUsTableId) throw new Error('§2 must succeed first')

    const startedAt = Date.now()
    let lastStatus: string | undefined

    while (Date.now() - startedAt < DEPLOY_TIMEOUT_MS) {
      const { data: list } = await api.genericTables.list(bootstrap.tenantSlug!, bootstrap.datalakeSlug!)
      const ours = (list.data ?? []).find((t) => t.id === s.contactUsTableId)
      lastStatus = ours?.status

      if (lastStatus === 'deployed') return

      await new Promise((r) => setTimeout(r, DEPLOY_POLL_MS))
    }

    throw new Error(
      `Contact Us Submissions table did not reach :deployed within ${DEPLOY_TIMEOUT_MS}ms ` +
        `(last status: ${lastStatus ?? '(not found in listing)'})`,
    )
  }, DEPLOY_TIMEOUT_MS + 30_000)
})
