/**
 * bootstrap — healthcare industry self-bootstrap chain.
 *
 * Mirrors Playwright specs:
 *   playwright-e2e/tests/sign-up.spec.ts        §1, §2  (register + confirm)
 *   playwright-e2e/tests/tenant-setup.spec.ts   §4      (create tenant)
 *   playwright-e2e/tests/datalake-setup.spec.ts §1, §2  (create datalake)
 *
 * State files this spec touches:
 *   READS:  base.state.json                     (names + creds, never mutated)
 *   READS:  <runId>/bootstrap.state.json        (own prior output, if any)
 *   WRITES: <runId>/bootstrap.state.json        (own slice — IDs + tokens)
 *
 * The runId is generated OUTSIDE this suite by `pnpm state:create:healthcare`.
 * Re-runs short-circuit completed steps via ctx.skip() — Pattern ① state-
 * machine flow tests, one it() per transition.
 */
import { createSession, type PlatformApi } from '@alvera-ai/platform-sdk'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildApi } from '../../src/api'
import { config } from '../../src/env'
import {
  type BaseState,
  type BootstrapState,
  type Industry,
  loadBase,
  loadSpec,
  saveSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function emptyBootstrap(): BootstrapState {
  return {
    rootBearer: null,
    sarahUserId: null,
    sarahTenantlessBearer: null,
    tenantId: null,
    tenantSlug: null,
    sarahSessionToken: null,
    datalakeId: null,
    datalakeSlug: null,
  }
}

describe('healthcare/bootstrap', () => {
  let base: BaseState
  let s: BootstrapState // own slice — only this spec writes to it
  let rootApi: PlatformApi
  let sarahTenantlessApi: PlatformApi
  let sarahTenantApi: PlatformApi

  beforeAll(() => {
    base = loadBase(INDUSTRY)
    // Pick up any prior bootstrap output from this runId (rerun short-circuits)
    s = loadSpec(INDUSTRY, 'bootstrap') ?? emptyBootstrap()
  })

  // ─── §1 root admin signs in (tenantless Bearer) ────────────────────────
  it('§1 root admin signs in', async (ctx) => {
    if (s.rootBearer) {
      rootApi = buildApi(s.rootBearer)
      try {
        await rootApi.sessions.verify()
        ctx.skip()
        return
      } catch {
        // token expired; fall through and re-sign-in
      }
    }
    const session = await createSession({
      baseUrl: config.baseUrl,
      email: config.rootEmail,
      password: config.rootPassword,
    })
    expect(session.sessionToken).toBeTruthy()
    rootApi = buildApi(session.sessionToken)
    s.rootBearer = session.sessionToken
    saveSpec(INDUSTRY, 'bootstrap', s)
  })

  // ─── §2 sign sarah up (industry admin) ─────────────────────────────────
  it('§2 sign sarah up', async (ctx) => {
    if (s.sarahUserId) {
      ctx.skip()
      return
    }
    const { data } = await rootApi.auth.signUp({
      email: base.sarahEmail,
      password: base.sarahPassword,
      first_name: 'Sarah',
      last_name: 'Mitchell',
    })
    expect(data.id).toMatch(UUID_RE)
    s.sarahUserId = data.id ?? null
    saveSpec(INDUSTRY, 'bootstrap', s)
  })

  // ─── §3 root confirms sarah ────────────────────────────────────────────
  it('§3 root confirms sarah', async (ctx) => {
    if (!s.sarahUserId) throw new Error('§2 must succeed first')
    if (s.sarahTenantlessBearer) {
      ctx.skip()
      return
    }
    await rootApi.admin.confirmUser(s.sarahUserId)
  })

  // ─── §4 sarah signs in (tenantless — no tenant exists yet) ─────────────
  it('§4 sarah signs in (tenantless)', async (ctx) => {
    if (s.sarahTenantlessBearer) {
      sarahTenantlessApi = buildApi(s.sarahTenantlessBearer)
      try {
        await sarahTenantlessApi.sessions.verify()
        ctx.skip()
        return
      } catch {
        // token expired; fall through
      }
    }
    const session = await createSession({
      baseUrl: config.baseUrl,
      email: base.sarahEmail,
      password: base.sarahPassword,
    })
    expect(session.sessionToken).toBeTruthy()
    expect(session.tenant).toBeNull()
    sarahTenantlessApi = buildApi(session.sessionToken)
    s.sarahTenantlessBearer = session.sessionToken
    saveSpec(INDUSTRY, 'bootstrap', s)
  })

  // ─── §5 sarah creates tenant — captures tenantId + tenantSlug ─────────
  // We deliberately DO NOT trust the session_token returned by POST /tenants.
  // §6 mints a fresh tenant-scoped Bearer via POST /sessions (with
  // tenant_slug). After bootstrap, only the tenant-scoped session is used.
  it('§5 sarah creates tenant', async (ctx) => {
    if (s.tenantId && s.tenantSlug) {
      ctx.skip()
      return
    }
    const { data } = await sarahTenantlessApi.tenants.create({
      name: base.tenantName,
    })
    expect(data.tenant?.id).toMatch(UUID_RE)
    expect(data.tenant?.slug).toMatch(/^vitest-e2e-healthcare-\d+$/)
    s.tenantId = data.tenant?.id ?? null
    s.tenantSlug = data.tenant?.slug ?? null
    saveSpec(INDUSTRY, 'bootstrap', s)
  })

  // ─── §6 sarah signs in tenant-scoped — the canonical Bearer ───────────
  it('§6 sarah signs in tenant-scoped', async (ctx) => {
    if (!s.tenantSlug) throw new Error('§5 must succeed first')
    if (s.sarahSessionToken) {
      sarahTenantApi = buildApi(s.sarahSessionToken)
      try {
        await sarahTenantApi.sessions.verify()
        ctx.skip()
        return
      } catch {
        // expired; re-sign-in
      }
    }
    const session = await createSession({
      baseUrl: config.baseUrl,
      email: base.sarahEmail,
      password: base.sarahPassword,
      tenantSlug: s.tenantSlug,
    })
    expect(session.tenant?.slug).toBe(s.tenantSlug)
    expect(session.role?.name).toMatch(/admin/i)
    s.sarahSessionToken = session.sessionToken
    saveSpec(INDUSTRY, 'bootstrap', s)
    sarahTenantApi = buildApi(s.sarahSessionToken)
  })

  // ─── §7 sarah creates healthcare datalake ──────────────────────────────
  it('§7 sarah creates healthcare datalake', async (ctx) => {
    if (s.datalakeId && s.datalakeSlug) {
      ctx.skip()
      return
    }
    if (!s.tenantSlug) throw new Error('§5 must succeed first')

    // Postgres + LocalStack S3 connection values match playwright-e2e's
    // datalake-setup.spec.ts so both suites target the same dev-stack.
    const DB_HOST = 'localhost'
    const DB_PORT = 5432
    const DB_USER = 'postgres'
    const DB_PASS = 'postgres'
    const DB_NAME = 'alvera_dev_healthcare'
    const UNREG_SCHEMA = `e2e_${base.runId}_unreg`
    const REG_SCHEMA = `e2e_${base.runId}_reg`

    const S3 = {
      __type__: 'aws',
      region: 'us-east-1',
      access_key_id: 'test',
      secret_access_key: 'test',
      endpoint: 'http://localhost:4566',
    } as const

    const { data } = await sarahTenantApi.datalakes.create(s.tenantSlug, {
      name: base.datalakeName,
      description: 'Primary healthcare datalake for patient data management',
      data_domain: 'healthcare',
      timezone: 'America/New_York',
      pool_size: 5,

      unregulated_db_writer_host: DB_HOST,
      unregulated_db_writer_port: DB_PORT,
      unregulated_db_writer_name: DB_NAME,
      unregulated_db_writer_schema: UNREG_SCHEMA,
      unregulated_db_writer_auth_method: 'password',
      unregulated_db_writer_user: DB_USER,
      unregulated_db_writer_pass: DB_PASS,
      unregulated_db_writer_enable_ssl: false,
      unregulated_db_reader_host: DB_HOST,
      unregulated_db_reader_port: DB_PORT,
      unregulated_db_reader_name: DB_NAME,
      unregulated_db_reader_schema: UNREG_SCHEMA,
      unregulated_db_reader_auth_method: 'password',
      unregulated_db_reader_user: DB_USER,
      unregulated_db_reader_pass: DB_PASS,
      unregulated_db_reader_enable_ssl: false,

      regulated_data_db_writer_host: DB_HOST,
      regulated_data_db_writer_port: DB_PORT,
      regulated_data_db_writer_name: DB_NAME,
      regulated_data_db_writer_schema: REG_SCHEMA,
      regulated_data_db_writer_auth_method: 'password',
      regulated_data_db_writer_user: DB_USER,
      regulated_data_db_writer_pass: DB_PASS,
      regulated_data_db_writer_enable_ssl: false,
      regulated_data_db_reader_host: DB_HOST,
      regulated_data_db_reader_port: DB_PORT,
      regulated_data_db_reader_name: DB_NAME,
      regulated_data_db_reader_schema: REG_SCHEMA,
      regulated_data_db_reader_auth_method: 'password',
      regulated_data_db_reader_user: DB_USER,
      regulated_data_db_reader_pass: DB_PASS,
      regulated_data_db_reader_enable_ssl: false,

      unregulated_cloud_storage: { ...S3, bucket: 'healthcare-lake-unregulated' },
      regulated_cloud_storage: { ...S3, bucket: 'healthcare-lake-regulated' },
    })

    expect(data.id).toMatch(UUID_RE)
    expect(data.slug).toBeTruthy()
    s.datalakeId = data.id ?? null
    s.datalakeSlug = data.slug ?? null
    saveSpec(INDUSTRY, 'bootstrap', s)
  })

  // ─── §8 enqueue datalake migrations (blocking — runs before §9 poll) ──
  // POST /datalakes only persists the metadata row; without this step
  // data_activation_logs / MDM tables / dataset tables don't exist and
  // downstream ingest fails. Server enqueues a DatalakeMigrationWorker
  // Oban job and returns 202 — actual migrations run async; §9 polls.
  it('§8 enqueue datalake migrations', async (ctx) => {
    if (!s.tenantSlug || !s.datalakeSlug) throw new Error('§5/§7 must succeed first')

    // Skip-fast on rerun: if the datalake already reached :ready, no need
    // to enqueue again (Oban does not dedupe by default — re-enqueueing
    // would burn a worker on a no-op).
    const { data: dl } = await sarahTenantApi.datalakes.get(s.tenantSlug, s.datalakeId!)
    if (dl.status === 'ready') {
      ctx.skip()
      return
    }

    const { data } = await sarahTenantApi.datalakes.migrate(s.tenantSlug, s.datalakeSlug)
    expect(data.status).toBe('enqueued')
    expect(typeof data.job_id).toBe('number')
    expect(data.datalake_id).toBe(s.datalakeId)

    // Surface the job id so the operator can correlate with Oban state
    // (oban_jobs WHERE id = <job_id>) when §9's poll fails. Without this
    // log, vitest swallows the response body and we lose the trace.
    console.log(
      `[bootstrap §8] migrate enqueued: job_id=${data.job_id} ` +
        `datalake_id=${data.datalake_id} enqueued_at=${data.enqueued_at}`,
    )
  })

  // ─── §9 poll datalake until status === 'ready' (blocks the suite) ─────
  // Migrations are async — they run inside the DatalakeMigrationWorker
  // Oban job enqueued by §8. We poll GET /datalakes/:id every 15s up to
  // 5 min. Healthcare datalake migrations are heavy (industry repo
  // migration set + PostgREST deploy + bot-user provisioning); a cold
  // dev stack can take a couple of minutes. 5 min cap is generous
  // headroom without masking real regressions; 15s interval keeps log
  // noise low. The per-test timeout is set to 6 min so the poll loop
  // itself isn't capped by vitest's default 30s.
  it(
    '§9 datalake reaches status=ready',
    async () => {
      if (!s.datalakeId || !s.tenantSlug) throw new Error('§5/§7 must succeed first')

      const deadline = Date.now() + 5 * 60_000
      let lastStatus: string | undefined
      let pollCount = 0
      while (Date.now() < deadline) {
        const { data } = await sarahTenantApi.datalakes.get(s.tenantSlug, s.datalakeId)
        lastStatus = data.status
        pollCount += 1
        const elapsedSec = Math.round((Date.now() - (deadline - 5 * 60_000)) / 1_000)
        console.log(`[bootstrap §9] poll #${pollCount} t=${elapsedSec}s status=${lastStatus}`)
        if (lastStatus === 'ready') return
        await new Promise((r) => setTimeout(r, 15_000))
      }
      throw new Error(`datalake never reached :ready within 5 min (last status: ${lastStatus})`)
    },
    6 * 60_000,
  )

  // ─── §10 sanity: tenant + datalake reachable from listings ─────────────
  it('§10 tenant + datalake reachable from listings', async () => {
    if (!s.tenantSlug) throw new Error('§5 must succeed first')

    const { data: tenants } = await sarahTenantApi.tenants.list()
    const ourTenant = tenants.data?.find((t) => t.id === s.tenantId)
    expect(ourTenant?.slug).toBe(s.tenantSlug)
    expect(ourTenant?.name).toBe(base.tenantName)

    const { data: datalakes } = await sarahTenantApi.datalakes.list(s.tenantSlug)
    const ourDatalake = datalakes.data?.find((dl) => dl.id === s.datalakeId)
    expect(ourDatalake?.slug).toBe(s.datalakeSlug)
    expect(ourDatalake?.name).toBe(base.datalakeName)
  })

  // ─── §11 post-migration tables queryable via dataset-search ───────────
  // HTTP equivalent of the Elixir healthcare_migrations_test.exs assertion
  // "Repo.all succeeds for all healthcare schemas" — every dataset module
  // is queryable post-migration. Vitest can't hit the schemas directly,
  // but POST /datasets/:dataset/user-searches with `1 = 1` exercises the
  // same code path the dataset listing UI / search uses, requiring:
  //   • the dataset table + all joined tables exist (regulated_identifiers,
  //     regulated_human_names, regulated_contact_points, …)
  //   • the regulated-repo capability gate is satisfied
  //   • search_results infrastructure is in place
  //
  // status=:completed on a fresh tenant means the SQL ran with results=0.
  // Catches the "migration silently skipped a table" failure mode that
  // would otherwise only surface mid-pipeline in run-dac.
  it('§11 dataset-search post-migration smoke', async () => {
    if (!s.tenantSlug || !s.datalakeSlug) throw new Error('§5/§7 must succeed first')
    if (!s.sarahSessionToken) throw new Error('§6 must succeed first')

    // Build a fresh API client with sarah's tenant-scoped Bearer (the
    // outer-scope `sarahTenantApi` lacks the dataset-search wrappers).
    // Healthcare core datasets — patient + appointment cover the
    // join-heavy regulated tables (identifiers, names, contact points,
    // patient FK on appointments). Add more if a downstream spec needs
    // its dataset proven post-migration.
    const datasetsToProbe = ['patient', 'appointment'] as const

    for (const dataset of datasetsToProbe) {
      const { data } = await sarahTenantApi.datasets.createUserSearch(
        dataset,
        { search_query: '1 = 1' },
        { datalakeId: s.datalakeId ?? undefined },
      )
      if (data.status !== 'completed') {
        throw new Error(
          `dataset-search smoke for '${dataset}' failed: status=${data.status} ` +
            `error_message=${data.error_message ?? '(none)'}`,
        )
      }
      console.log(
        `[bootstrap §11] dataset=${dataset} status=${data.status} results_count=${data.results_count}`,
      )
    }
  })
})
