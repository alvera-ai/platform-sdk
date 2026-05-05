#!/usr/bin/env node
/**
 * Post-codegen patches on the openapi-ts output.
 *
 * Two passes, each applied to a specific generated file:
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

// Pass 3 — widen v.optional to v.nullish in response validators.
//
// openapi-ts emits `v.optional(...)` for non-required fields, which
// accepts `undefined` but rejects `null`. The Elixir/Phoenix API
// serialises absent values as JSON `null`, so every `v.optional`
// inside a response schema must become `v.nullish` (accepts both
// undefined and null). This is the root cause of the discriminated-
// union validation failures on tool body types — one `null` field
// inside a branch causes that branch to fail, and v.union reports
// the *first* branch's error instead.
patch(
  'src/generated/valibot.gen.ts',
  (s) => s.replace(/v\.optional\(/g, 'v.nullish('),
  'widened v.optional to v.nullish for null-returning API fields',
);

