# @alvera-ai/platform-sdk

Typed TypeScript SDK for the Alvera platform API.

Manage the resources that live under a tenant — data sources, tools, generic
tables, action status updaters, AI agents — with full type safety.

## Install

```bash
npm install @alvera-ai/platform-sdk
# or
pnpm add @alvera-ai/platform-sdk
```

## Quick start

```ts
import { createPlatformApi, createSession, ENVIRONMENTS } from '@alvera-ai/platform-sdk';

const baseUrl = ENVIRONMENTS.prod.base_url; // or ENVIRONMENTS.local / ENVIRONMENTS.demo

// 1. Exchange credentials for a session token
const session = await createSession({
  baseUrl,
  email: process.env.ALVERA_EMAIL!,
  password: process.env.ALVERA_PASSWORD!,
  tenantSlug: 'acme',
});

// 2. Build the API client with that token
const api = createPlatformApi({ baseUrl, sessionToken: session.sessionToken });

// 3. Use it
await api.ping();

const { data: datalakes } = await api.datalakes.list('acme');

const { data: ds } = await api.dataSources.create('acme', 'acme-health', {
  name: 'Acme EMR',
  uri: 'our-emr:acme',
  description: 'Acme EMR system',
  status: 'active',
  is_default: true,
});

const { data: tool } = await api.tools.create('acme', {
  name: 'Acme Manual Upload',
  intent: 'data_exchange',
  status: 'active',
  datalake_id: datalakes[0].id,
  data_source_id: ds.id,
  body: { __type__: 'manual_upload' },
});
```

## Authentication

The SDK uses **session-based** auth.

1. Call `createSession({ baseUrl, email, password, tenantSlug })` with your
   Alvera login credentials and the tenant you want to operate on.
2. The returned `sessionToken` is a Bearer token, valid for 24 hours by
   default (override with `expiresIn`, max 30 days).
3. Pass the token into `createPlatformApi({ baseUrl, sessionToken })`.
4. When done, optionally call `revokeSession()` to invalidate the token.

```ts
import { createSession, createPlatformApi, revokeSession } from '@alvera-ai/platform-sdk';

const session = await createSession({
  baseUrl, email, password, tenantSlug: 'acme', expiresIn: 3600,
});
const api = createPlatformApi({ baseUrl, sessionToken: session.sessionToken });
// ... use api ...
await revokeSession();
```

`session.expiresAt` is an ISO-8601 timestamp — check it before long-running
work and re-authenticate if needed.

## Environments

The base URLs ship with the package, derived at build time from the
`servers[]` block of the committed OpenAPI spec (`spec/openapi.yaml`). The
generated map is exported as `ENVIRONMENTS`:

```ts
import { ENVIRONMENTS, DEFAULT_ENVIRONMENT } from '@alvera-ai/platform-sdk';

ENVIRONMENTS.local.base_url; // http://localhost:4000
ENVIRONMENTS.demo.base_url;  // https://platform-hh.alvera.ai
ENVIRONMENTS.prod.base_url;  // https://app.alvera.ai

DEFAULT_ENVIRONMENT; // 'prod'
```

The CLI resolves a base URL with this precedence (highest first):

1. `ALVERA_BASE_URL` env var (explicit URL override — useful for tunnels /
   ephemeral servers)
2. `base_url` pinned in the profile (written when the user passes a custom URL
   to `alvera configure` or `alvera login --base-url …`)
3. `ENVIRONMENTS[env].base_url` where `env` is the first of: `--env <name>`
   flag, `ALVERA_ENV` env var, the profile's `environment` entry, or
   `DEFAULT_ENVIRONMENT`

Adding, renaming, or removing environments happens in the platform repo (the
`servers/0` function in `lib/platform_api/api_spec.ex`); rerun
`pnpm regen` in the SDK to pick up the change.

## Resources

| Resource                | Operations                                  |
|-------------------------|---------------------------------------------|
| `ping`                   | health check                                                                 |
| `sessions`               | `verify`                                                                     |
| `datasets`               | `search`                                                                     |
| `datalakes`              | `list`, `get`, `create`                                                      |
| `dataSources`            | `list`, `create`, `update`                                                   |
| `tools`                  | `list`, `get`, `create`, `update`, `delete`                                  |
| `genericTables`          | `list`, `create`                                                             |
| `actionStatusUpdaters`   | `list`, `create`, `update`                                                   |
| `aiAgents`               | `list`, `get`, `create`, `update`, `delete`                                  |
| `connectedApps`          | `list`, `get`, `create`, `update`, `syncRoutes`, `resolvePage`, `updateMessageTracking` |
| `dataActivationClients`  | `ingest`, `ingestFile`, `createUploadLink`                                   |
| `mdm`                    | `verify`                                                                     |
| `workflows`              | `execute`                                                                    |

Tenant and datalake provisioning are performed by Alvera admins — contact your
representative to onboard a new tenant.

## Error handling

All methods throw on non-2xx responses (`throwOnError: true`). Wrap calls in
`try/catch` and inspect the thrown error for status and response body.

```ts
try {
  await api.tools.create('acme', payload);
} catch (err) {
  console.error('Tool creation failed:', err);
}
```

## CLI

The package ships a companion CLI (`alvera`) for ad-hoc calls against the
platform API. Install the package (globally, or via `npx`) and authenticate
once — subsequent commands reuse the stored session.

```bash
# Run without installing
npx @alvera-ai/platform-sdk --help

# Or install globally
npm install -g @alvera-ai/platform-sdk
alvera --help
```

### Configuration

`alvera` stores state under `~/.alvera-ai/`, AWS CLI–style:

| File                        | Purpose                                           |
|-----------------------------|---------------------------------------------------|
| `~/.alvera-ai/config`       | Per-profile defaults (base URL, tenant, email)    |
| `~/.alvera-ai/credentials`  | Per-profile session token and expiration (0600)   |

Both files are INI. The default profile is `[default]`; additional profiles
live under `[profile <name>]` in `config` and `[<name>]` in `credentials`.

Every command accepts `--profile <name>` and `--env <name>`. Environment
variables (`ALVERA_PROFILE`, `ALVERA_ENV`, `ALVERA_BASE_URL`, `ALVERA_TENANT`,
`ALVERA_EMAIL`, `ALVERA_PASSWORD`, `ALVERA_SESSION_TOKEN`) take precedence
over file values.

### Getting started

```bash
alvera env list                           # show local / demo / prod
alvera configure                          # pick environment + default tenant
alvera login --email me@acme.com --tenant acme
alvera ping
alvera datalakes list
alvera tools create --body-file tool.json
alvera logout
```

Per-command env switch (no profile edit):

```bash
alvera --env local ping
ALVERA_ENV=demo alvera datalakes list
```

Pin an env into a profile:

```bash
alvera --profile staging env use demo
alvera --profile staging datalakes list
```

Override the base URL for an ad-hoc host (tunnels, local branches):

```bash
ALVERA_BASE_URL=https://pr-123.preview.alvera.ai alvera ping
```

### Command surface

```
alvera configure
alvera login   [--email] [--password] [--tenant] [--base-url] [--expires-in]
alvera logout
alvera whoami
alvera ping
alvera env                    list | use <name>

alvera datalakes              list | get <id> | create
alvera data-sources           list <datalake> | create <datalake> | update <datalake> <id>
alvera tools                  list | get <id> | create | update <id> | delete <id>
alvera generic-tables         list <datalake> | create <datalake>
alvera action-status-updaters list | create | update <id>
alvera ai-agents              list <datalake> | get <datalake> <id> | create <datalake>
                              | update <datalake> <id> | delete <datalake> <id>
alvera sessions-verify
alvera datasets               search <dataset> [--datalake-id] [--page] [--page-size]
alvera connected-apps         list <datalake> | get <datalake> <id> | create <datalake>
                              | update <datalake> <id> | sync-routes <datalake> <id>
                              | resolve-page <slug> | update-message-tracking <slug>
alvera data-activation-clients  ingest <slug> | ingest-file <slug> <key>
                                | upload-link <slug> <filename> [--content-type]
alvera mdm                    verify <datalake>
alvera workflows              execute <workflow-slug>
```

All `create` / `update` commands require `--body '<json>'` or `--body-file <path>`
(use `-` for stdin). A tenant positional argument is optional when the profile
has a default tenant configured. Output is pretty-printed JSON on stdout;
status messages and prompts go to stderr so responses stay pipeable.

## Regenerating the typed client

The typed client is generated from `spec/openapi.yaml` using
[`@hey-api/openapi-ts`](https://heyapi.dev/). The spec is produced by the
platform repo and committed here, so this repo is fully self-contained at CI
time.

To pull a newer spec from the sibling platform repo:

```bash
# in the platform repo
mix openapi.spec.yaml --spec PlatformApi.ApiSpec openapi.yaml
git commit -am "feat(api): …"

# in this repo
cp ../platform/openapi.yaml spec/openapi.yaml
pnpm regen        # gen-environments + codegen + check-coverage
pnpm build        # compile to dist/
git commit -am "chore: sync openapi spec"
```

`pnpm regen` runs `gen-environments` (rebuilds
`src/environments.generated.ts` from `servers[]`), then `codegen`, then
`check-coverage`.

## Releases

This package uses
[release-please](https://github.com/googleapis/release-please) plus
[Conventional Commits](https://www.conventionalcommits.org/). Commits on
`main` of the form `feat: …`, `fix: …`, `chore: …` feed into an automated
"chore(main): release X.Y.Z" PR that bumps `package.json` and updates
`CHANGELOG.md`. Merging that PR tags `vX.Y.Z`, which in turn triggers the
existing npm publish workflow.

## License

MIT
