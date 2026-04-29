import { createIsolatedPlatformApi, type PlatformApi } from '@alvera-ai/platform-sdk'
import { config } from './env'

// ---------------------------------------------------------------------------
// Thin SDK builder. Pattern ① specs construct their own PlatformApi instances
// per step (each step has a different Bearer scope: root → tenantless →
// tenant-scoped). MUST use the isolated factory: a single test file holds
// multiple APIs concurrently (e.g. rootApi + sarahTenantlessApi + sarahTenantApi
// in 01-bootstrap, sarahTenantApi + emmaTenantlessApi + emmaTenantApi in
// 02-invite-team). The default singleton factory mutates a shared client so
// the most-recent buildApi() call clobbers every previous instance's auth.
// ---------------------------------------------------------------------------

export function buildApi(sessionToken: string): PlatformApi {
  return createIsolatedPlatformApi({ baseUrl: config.baseUrl, sessionToken })
}
