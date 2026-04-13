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
import { createPlatformApi, createSession } from '@alvera-ai/platform-sdk';

const baseUrl = 'https://admin.alvera.ai';

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

## Resources

| Resource                | Operations                                  |
|-------------------------|---------------------------------------------|
| `ping`                  | health check                                |
| `datalakes`             | `list`, `get`                               |
| `dataSources`           | `list`, `create`, `update`                  |
| `tools`                 | `list`, `get`, `create`, `update`, `delete` |
| `genericTables`         | `list`, `create`                            |
| `actionStatusUpdaters`  | `list`, `create`, `update`                  |
| `aiAgents`              | `list`, `get`, `create`, `update`, `delete` |

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

## Regenerating the typed client

The typed client is generated from the live OpenAPI spec at
`https://admin.alvera.ai/api/openapi` using
[`@hey-api/openapi-ts`](https://heyapi.dev/).

```bash
pnpm regen        # fetch latest spec + regenerate
pnpm codegen      # regenerate from the pinned openapi.json
pnpm build        # compile to dist/
```

## License

MIT
