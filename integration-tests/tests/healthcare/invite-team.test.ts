/**
 * invite-team — Sarah invites Emma; Emma signs up + accepts the invite.
 *
 * Mirrors playwright-e2e/tests/invite-team.spec.ts (which uses the dev mailbox
 * to find the invitation link). Vitest hits HTTP directly, so Emma discovers
 * her pending invitation via GET /api/v1/invitations rather than email.
 *
 * State files this spec touches:
 *   READS:  base.state.json
 *   READS:  <runId>/bootstrap.state.json     REQUIRED — needs sarahSessionToken
 *                                            + tenantSlug + rootBearer
 *   READS:  <runId>/invite-team.state.json   own prior output (rerun)
 *   WRITES: <runId>/invite-team.state.json   emmaUserId, emmaSessionToken, …
 *
 * The invitationId is module-scoped (transient, never persisted). Once Emma
 * accepts, it's consumed and never needed again.
 */
import { createSession, type PlatformApi } from '@alvera-ai/platform-sdk'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildApi } from '../../src/api'
import { config } from '../../src/env'
import {
  type BaseState,
  type BootstrapState,
  type Industry,
  type InviteTeamState,
  loadBase,
  loadSpec,
  requireSpec,
  saveSpec,
} from '../../src/state'

const INDUSTRY: Industry = 'healthcare'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// hey-api throws response body verbatim on non-2xx. The "already invited"
// 422 looks like { errors: [{ detail: "is already invited", ... }, ...] }.
function isAlreadyInvitedError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const errors = (err as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return false
  return errors.some(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as { detail?: unknown }).detail === 'string' &&
      (e as { detail: string }).detail.toLowerCase().includes('already invited'),
  )
}

function emptyInviteTeam(): InviteTeamState {
  return {
    emmaUserId: null,
    emmaTenantlessBearer: null,
    emmaSessionToken: null,
    jamesUserId: null,
    jamesTenantlessBearer: null,
    jamesSessionToken: null,
  }
}

describe('healthcare/invite-team', () => {
  let base: BaseState
  let bootstrap: BootstrapState
  let s: InviteTeamState
  let rootApi: PlatformApi
  let sarahTenantApi: PlatformApi
  let emmaTenantlessApi: PlatformApi
  let invitationId: string // transient — captured at §5, used at §6

  beforeAll(() => {
    base = loadBase(INDUSTRY)
    bootstrap = requireSpec(INDUSTRY, 'bootstrap')
    s = loadSpec(INDUSTRY, 'invite-team') ?? emptyInviteTeam()

    if (!bootstrap.sarahSessionToken || !bootstrap.tenantSlug || !bootstrap.rootBearer) {
      throw new Error(
        'bootstrap.state.json incomplete — sarahSessionToken / tenantSlug / rootBearer missing',
      )
    }
    sarahTenantApi = buildApi(bootstrap.sarahSessionToken)
    rootApi = buildApi(bootstrap.rootBearer)
  })

  // ─── §1 sarah lists current team — only herself as admin ──────────────
  it('§1 sarah lists current team', async () => {
    const { data: verify } = await sarahTenantApi.sessions.verify()
    expect(verify.tenant?.slug).toBe(bootstrap.tenantSlug)
    expect(verify.role?.name).toMatch(/admin/i)
  })

  // ─── §2 sarah invites emma as a Member ───────────────────────────────
  it('§2 sarah invites emma', async (ctx) => {
    if (s.emmaSessionToken) {
      ctx.skip()
      return
    }

    try {
      const { data } = await sarahTenantApi.invitations.create(bootstrap.tenantSlug!, {
        email: base.emmaEmail,
        role: 'member',
      })
      expect(data.id).toMatch(UUID_RE)
      expect(data.email).toBe(base.emmaEmail)
      expect(data.role).toBe('member')
    } catch (err) {
      // Idempotent retry path: previous run may have succeeded server-side
      // even if local state didn't capture downstream. Treat 422 "already
      // invited" as success — the pending invitation is on the server and
      // §5 will discover it via the recipient's listing.
      if (!isAlreadyInvitedError(err)) throw err
    }
  })

  // ─── §3 emma signs up ────────────────────────────────────────────────
  it('§3 emma signs up', async (ctx) => {
    if (s.emmaUserId) {
      ctx.skip()
      return
    }
    const { data } = await rootApi.auth.signUp({
      email: base.emmaEmail,
      password: base.sarahPassword, // shared dev.env password across users
      first_name: 'Emma',
      last_name: 'Wilson',
    })
    expect(data.id).toMatch(UUID_RE)
    s.emmaUserId = data.id ?? null
    saveSpec(INDUSTRY, 'invite-team', s)
  })

  // ─── §4 root confirms emma ───────────────────────────────────────────
  it('§4 root confirms emma', async (ctx) => {
    if (!s.emmaUserId) throw new Error('§3 must succeed first')
    if (s.emmaTenantlessBearer) {
      ctx.skip()
      return
    }
    await rootApi.admin.confirmUser(s.emmaUserId)
  })

  // ─── §5 emma signs in tenantless + discovers her invitation ──────────
  it('§5 emma signs in (tenantless) + lists pending invitations', async (ctx) => {
    if (s.emmaSessionToken) {
      ctx.skip()
      return
    }
    if (s.emmaTenantlessBearer) {
      emmaTenantlessApi = buildApi(s.emmaTenantlessBearer)
      try {
        await emmaTenantlessApi.sessions.verify()
      } catch {
        s.emmaTenantlessBearer = null
      }
    }
    if (!s.emmaTenantlessBearer) {
      const session = await createSession({
        baseUrl: config.baseUrl,
        email: base.emmaEmail,
        password: base.sarahPassword,
      })
      expect(session.tenant).toBeNull()
      s.emmaTenantlessBearer = session.sessionToken
      saveSpec(INDUSTRY, 'invite-team', s)
      emmaTenantlessApi = buildApi(s.emmaTenantlessBearer)
    }

    const { data: invites } = await emmaTenantlessApi.invitations.list()
    const ours = invites.data?.find((i) => i.tenant?.slug === bootstrap.tenantSlug)
    expect(ours).toBeDefined()
    expect(ours?.email).toBe(base.emmaEmail)
    expect(ours?.role).toBe('member')
    invitationId = ours!.id!
    expect(invitationId).toMatch(UUID_RE)
  })

  // ─── §6 emma accepts the invitation ──────────────────────────────────
  it('§6 emma accepts the invitation', async (ctx) => {
    if (s.emmaSessionToken) {
      ctx.skip()
      return
    }
    if (!invitationId) throw new Error('§5 must run in this session to capture invitationId')

    const { data: membership } = await emmaTenantlessApi.invitations.accept(invitationId)
    expect(membership.id).toMatch(UUID_RE)
    expect(membership.role).toBe('member')
    expect(membership.tenant?.slug).toBe(bootstrap.tenantSlug)
  })

  // ─── §7 emma signs in tenant-scoped — proves membership took effect ──
  it('§7 emma signs in tenant-scoped', async (ctx) => {
    if (s.emmaSessionToken) {
      const cached = buildApi(s.emmaSessionToken)
      try {
        await cached.sessions.verify()
        ctx.skip()
        return
      } catch {
        s.emmaSessionToken = null
      }
    }
    if (!bootstrap.tenantSlug) throw new Error('tenantSlug missing')

    const session = await createSession({
      baseUrl: config.baseUrl,
      email: base.emmaEmail,
      password: base.sarahPassword,
      tenantSlug: bootstrap.tenantSlug,
    })
    expect(session.tenant?.slug).toBe(bootstrap.tenantSlug)
    expect(session.role?.name).toMatch(/member|tenant_member/i)
    s.emmaSessionToken = session.sessionToken
    saveSpec(INDUSTRY, 'invite-team', s)
  })
})
