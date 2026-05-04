#!/usr/bin/env node
/**
 * Post-codegen patches on the openapi-ts output.
 *
 * Six passes, each applied to a specific generated file:
 *
 * 1. pathSerializer.gen.ts — widen the core `ArrayStyle` union to include
 *    `'deepObject'`. The platform spec uses `style: deepObject` on array
 *    query params (Flop filters), which openapi-ts emits verbatim as
 *      querySerializer: { parameters: { filters: { array: { style: 'deepObject' } } } }
 *    but the hey-api client's `ArrayStyle` type only allows
 *    `'form' | 'spaceDelimited' | 'pipeDelimited'`. The runtime serializer
 *    (utils.gen.ts) already handles `'deepObject'` for arrays, so widening
 *    the type is safe.
 *
 * 2. sdk.gen.ts — annotate validator callback parameters as `unknown`.
 *    hey-api emits `requestValidator`/`responseValidator` as
 *      async (data) => await v.parseAsync(..., data)
 *    whose `data` parameter relies on contextual typing via a distributive
 *    conditional on the operation's TData. For POST methods with a real
 *    request body, the conditional produces a multi-branch union that TS
 *    cannot contextually type through, triggering TS7006 on every such
 *    callback. Rewriting to `async (data: unknown) => ...` makes the
 *    parameter explicit; `v.parseAsync(schema, unknown)` accepts `unknown`
 *    at runtime, so behavior is unchanged.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');

function patch(
  relPath: string,
  apply: (before: string) => string,
  description: string,
): void {
  const abs = resolve(root, relPath);
  const before = readFileSync(abs, 'utf8');
  const after = apply(before);
  if (before === after) {
    console.error(
      `patch-generated: no-op for ${relPath} — has openapi-ts changed its ` +
        `output? Update scripts/patch-generated.ts.`,
    );
    process.exit(1);
  }
  writeFileSync(abs, after);
  console.log(`patch-generated: ${description}`);
}

// Pass 1 — widen ArrayStyle to include 'deepObject'.
patch(
  'src/generated/core/pathSerializer.gen.ts',
  (s) =>
    s.replace(
      "export type ArrayStyle = 'form' | 'spaceDelimited' | 'pipeDelimited';",
      "export type ArrayStyle = 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject';",
    ),
  'widened ArrayStyle to include deepObject',
);

// Pass 2 — annotate validator callbacks as `(data: unknown)`.
// Matches both `requestValidator: async (data) =>` and `responseValidator: async (data) =>`.
patch(
  'src/generated/sdk.gen.ts',
  (s) =>
    s.replace(
      /(requestValidator|responseValidator): async \(data\) =>/g,
      '$1: async (data: unknown) =>',
    ),
  'annotated validator callbacks as (data: unknown)',
);

// Pass 3 — make tenant_slug optional in SessionRequest.
// The OpenAPI spec lists only email + password as required and marks
// tenant_slug as nullable, but openapi-ts emits it as a required v.string().
// Tenantless sign-ins (root admin, pre-tenant flows) omit tenant_slug entirely.
patch(
  'src/generated/valibot.gen.ts',
  (s) =>
    s.replace(
      'export const vSessionRequest = v.object({\n' +
        '    email: v.pipe(v.string(), v.email()),\n' +
        '    expires_in: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(60), v.maxValue(2592000))),\n' +
        '    password: v.pipe(v.string(), v.minLength(1)),\n' +
        '    tenant_slug: v.string()\n' +
        '});',
      'export const vSessionRequest = v.object({\n' +
        '    email: v.pipe(v.string(), v.email()),\n' +
        '    expires_in: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(60), v.maxValue(2592000))),\n' +
        '    password: v.pipe(v.string(), v.minLength(1)),\n' +
        '    tenant_slug: v.optional(v.string())\n' +
        '});',
    ),
  'made tenant_slug optional in vSessionRequest (GH-34)',
);

// Pass 4 — make tenant_slug optional in SessionRequest TypeScript type.
// Same root cause as pass 3: codegen emits `tenant_slug: string` but the
// OpenAPI spec only requires email + password.
patch(
  'src/generated/types.gen.ts',
  (s) =>
    s.replace(
      '     * Tenant slug to create session for\n' +
        '     */\n' +
        '    tenant_slug: string;\n' +
        '};',
      '     * Tenant slug to create session for\n' +
        '     */\n' +
        '    tenant_slug?: string;\n' +
        '};',
    ),
  'made tenant_slug optional in SessionRequest type (GH-34)',
);

// Pass 5 — make role + tenant nullish in SessionResponse valibot schema.
// The OpenAPI spec only requires `type` + `data_access_mode`; role and tenant
// are absent for tenantless sessions but openapi-ts emits them as required
// v.object() because they use $ref (not inline nullable).
patch(
  'src/generated/valibot.gen.ts',
  (s) =>
    s
      .replace(
        '    role: v.object({\n' +
          '        id: v.pipe(v.string(), v.uuid()),\n' +
          '        name: v.string()\n' +
          '    }),\n' +
          '    session_token: v.nullable(v.string()),\n' +
          '    tenant: v.object({\n' +
          '        id: v.pipe(v.string(), v.uuid()),\n' +
          '        name: v.string(),\n' +
          '        slug: v.string()\n' +
          '    }),',
        '    role: v.nullish(v.object({\n' +
          '        id: v.pipe(v.string(), v.uuid()),\n' +
          '        name: v.string()\n' +
          '    })),\n' +
          '    session_token: v.nullable(v.string()),\n' +
          '    tenant: v.nullish(v.object({\n' +
          '        id: v.pipe(v.string(), v.uuid()),\n' +
          '        name: v.string(),\n' +
          '        slug: v.string()\n' +
          '    })),',
      ),
  'made role + tenant nullish in vSessionResponse (GH-34)',
);

// Pass 6 — make role + tenant optional in SessionResponse TypeScript type.
patch(
  'src/generated/types.gen.ts',
  (s) =>
    s.replace(
      '    role: {\n' +
        '        id: string;\n' +
        '        name: string;\n' +
        '    };\n' +
        '    /**\n' +
        '     * Bearer token for subsequent API requests. Returned on create, null on verify (token is not re-exposed).\n' +
        '     */\n' +
        '    session_token: string | null;\n' +
        '    /**\n' +
        '     * Authenticated tenant\n' +
        '     */\n' +
        '    tenant: {\n' +
        '        id: string;\n' +
        '        name: string;\n' +
        '        slug: string;\n' +
        '    };',
      '    role?: {\n' +
        '        id: string;\n' +
        '        name: string;\n' +
        '    } | null;\n' +
        '    /**\n' +
        '     * Bearer token for subsequent API requests. Returned on create, null on verify (token is not re-exposed).\n' +
        '     */\n' +
        '    session_token: string | null;\n' +
        '    /**\n' +
        '     * Authenticated tenant\n' +
        '     */\n' +
        '    tenant?: {\n' +
        '        id: string;\n' +
        '        name: string;\n' +
        '        slug: string;\n' +
        '    } | null;',
    ),
  'made role + tenant optional in SessionResponse type (GH-34)',
);
