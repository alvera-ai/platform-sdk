# `integration-tests/`

Vitest-based HTTP integration tests that hit the real Phoenix dev server
of the **alvera/platform** repo via this package's own SDK
(`@alvera-ai/platform-sdk`). The suite is the **canonical executable
playbook** for end-to-end setup of an Alvera tenant — domain by domain
(healthcare, payment-risk, accounts-receivable). It doubles as the
SDK's own integration test surface.

## Conversational driver

For a guided, conversational way to drive the same flows in Claude
Code, install the [alvera-agent](https://github.com/alvera-ai/alvera-agent)
marketplace plugin:

```
/plugin marketplace add alvera-ai/alvera-agent
/plugin install platform-setup@alvera-agent
/platform-setup:healthcare        # or :payment-risk, :accounts-receivable, …
```

Each domain skill in alvera-agent walks the matching `tests/<domain>/`
directory in this folder. The skill is markdown; this is the executable
contract behind it.

## SDK consumption

The SDK is consumed via the `link:..` protocol — a local symlink to the
SDK source at the parent directory (this folder is a sibling of
`platform-sdk/src/`):

```json
// integration-tests/package.json
"dependencies": {
  "@alvera-ai/platform-sdk": "link:.."
}
```

`pnpm install` symlinks `node_modules/@alvera-ai/platform-sdk/` to the
SDK at the repo root. No clone, no rebuild — SDK changes are visible to
the suite immediately. **The integration-tests directory is NOT included
in the published npm tarball** (`files` field on the SDK's root
`package.json` whitelists only `src`, `README.md`, `LICENSE`).

## Prerequisites

Before running any spec here:

1. **Backing services running** — `make run-backing-services` (from repo
   root). Brings up SFTP + Cloudflare Images mocks.
2. **DB reset + Phoenix server up** — `make db-reset` and `make server`
   (leave the server running in another shell).
3. **Playwright state file exists** — Vitest reuses the tenant + credentials
   Playwright creates. Run:
   ```bash
   pnpm -C playwright-e2e state:create
   pnpm -C playwright-e2e test:tenant-setup
   ```
   This produces `playwright-e2e/playwright-state/e2e-state.json`, which
   Vitest reads for `sarahEmail` / `sarahPassword` / `tenantName` / `runId`.
   Override the path with `ALVERA_E2E_STATE_PATH=/some/other/path.json` if
   you need to.

## Running

```bash
make test-integration                      # preferred — does install + vitest
pnpm -C integration-tests test             # if deps are already installed
pnpm -C integration-tests test:watch       # dev loop
```

## Environment selection

Tests default to `local` (`http://localhost:4000`). Override with `ALVERA_ENV`:

```bash
ALVERA_ENV=local make test-integration     # default
ALVERA_ENV=demo make test-integration      # https://platform-hh.alvera.ai
ALVERA_ENV=prod make test-integration      # https://app.alvera.ai — be careful
```

Unknown values fail fast with a listed set of valid names. The catalogue
lives in [`src/env.ts`](src/env.ts) and mirrors `lib/platform_api/api_spec.ex`
servers.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ECONNREFUSED localhost:4000` | Phoenix dev server not running | `make server` |
| `Unknown ALVERA_ENV="..."` | Typo | Use `local` / `demo` / `prod` |
| `Module '@alvera-ai/platform-sdk' has no exported member 'X'` | Stale SDK pin — upstream renamed/added the export after the locked commit | `pnpm -C integration-tests update @alvera-ai/platform-sdk` |
| `Cannot find module '@alvera-ai/platform-sdk'` | Dependency not installed | `pnpm -C integration-tests install` |
| `Playwright state not found at ...` | Prerequisite step skipped | Run `state:create` + `test:tenant-setup` |
| `401 Unauthorized` on every request | State file credentials stale (DB reset but state file untouched) | Re-run `state:create` + `test:tenant-setup` |

## Updating the SDK dependency

The pin in `pnpm-lock.yaml` resolves to a specific commit on
[`alvera-ai/platform-sdk@main`](https://github.com/alvera-ai/platform-sdk).
Land changes upstream first, then bump locally:

```bash
# Bump to the latest main (re-resolves the GitHub ref)
pnpm -C integration-tests update @alvera-ai/platform-sdk

# Pin to a specific commit / tag / branch by editing package.json:
#   "github:alvera-ai/platform-sdk#<sha-or-tag-or-branch>"
# then `pnpm install` to refresh the lockfile
```

Only `pnpm-lock.yaml` should change in this repo when you bump — the SDK is
not a workspace package, no source files of it live here.

## Adding a new resource test

```ts
// integration-tests/tests/my-resource.test.ts
import { describe, expect, it } from 'vitest'
import { api } from '../src/api'
import { config } from '../src/env'

describe('my-resource', () => {
  it('lists my resource', async () => {
    const { data } = await api.myResource.list(config.tenantSlug)
    expect(Array.isArray(data.data)).toBe(true)
  })
})
```

Rules:
- Use `runId`-suffixed names for any created resource to avoid collisions
  across reruns without a DB reset.
- `api` and `session` are populated by `vitest.setup.ts` → `beforeAll`; never
  import them at module top-level and try to use them synchronously.
- Don't do cleanup that the platform can't yet support (e.g.
  `api.datalakes.delete` doesn't exist at time of writing).
