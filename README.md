# @alvera/platform-sdk

Typed TypeScript SDK for the Alvera platform API.

Manage the resources that live under a tenant — data sources, tools, generic
tables, action status updaters, AI agents — with full type safety.

## Install

```bash
npm install @alvera/platform-sdk
# or
pnpm add @alvera/platform-sdk
```

## Quick start

```ts
import { createPlatformApi } from '@alvera/platform-sdk';

const api = createPlatformApi({
  baseUrl: 'https://admin.alvera.ai',
  apiKey: process.env.ALVERA_API_KEY!,
});

// Health check
await api.ping();

// List datalakes for a tenant
const { data: datalakes } = await api.datalakes.list('acme');

// Create a data source
const { data: ds } = await api.dataSources.create('acme', 'acme-health', {
  name: 'Acme EMR',
  uri: 'our-emr:acme',
  description: 'Acme EMR system',
  status: 'active',
  is_default: true,
});

// Attach a tool to the data source
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

The SDK authenticates with an `X-API-Key` header. Obtain an API key for your
tenant from your Alvera admin.

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
