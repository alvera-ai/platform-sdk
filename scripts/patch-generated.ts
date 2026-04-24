#!/usr/bin/env node
/**
 * Post-codegen patch: widens the core ArrayStyle union to include 'deepObject'.
 *
 * The platform spec uses `style: deepObject` on array query params (Flop filters),
 * which openapi-ts emits verbatim into sdk.gen.ts as
 *   querySerializer: { parameters: { filters: { array: { style: 'deepObject' } } } }
 * but the hey-api client's ArrayStyle type only allows 'form' | 'spaceDelimited' |
 * 'pipeDelimited'. The runtime serializer (utils.gen.ts) already handles
 * 'deepObject' for arrays, so widening the type is safe.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const path = resolve(root, 'src/generated/core/pathSerializer.gen.ts');

const before = readFileSync(path, 'utf8');
const after = before.replace(
  "export type ArrayStyle = 'form' | 'spaceDelimited' | 'pipeDelimited';",
  "export type ArrayStyle = 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject';",
);

if (before === after) {
  console.error(
    'patch-generated: ArrayStyle declaration not found in pathSerializer.gen.ts — ' +
      'has openapi-ts changed its output? Update scripts/patch-generated.ts.',
  );
  process.exit(1);
}

writeFileSync(path, after);
console.log('patch-generated: widened ArrayStyle to include deepObject');
