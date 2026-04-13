#!/usr/bin/env node
// Fails if any generated `platformApi*` function is not referenced in
// src/client.ts. Catches the case where a new endpoint was added to the spec
// but the ergonomic wrapper was never written — preventing silent drift
// between the generated SDK and the public surface.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sdkPath = resolve(here, '..', 'src', 'generated', 'sdk.gen.ts');
const clientPath = resolve(here, '..', 'src', 'client.ts');

// Endpoints intentionally excluded from the factory (add with justification).
const ALLOWLIST = new Set([]);

const sdk = readFileSync(sdkPath, 'utf8');
const client = readFileSync(clientPath, 'utf8');

const generated = [...sdk.matchAll(/^export const (platformApi\w+)\s*=/gm)].map((m) => m[1]);
const missing = generated.filter((name) => !ALLOWLIST.has(name) && !client.includes(name));

if (missing.length === 0) {
  console.log(`✓ client.ts covers all ${generated.length} generated endpoints`);
  process.exit(0);
}

console.error(
  `✗ client.ts is missing wrappers for ${missing.length} generated endpoint(s):\n` +
    missing.map((n) => `  - ${n}`).join('\n') +
    `\n\nAdd wrappers in src/client.ts, or (if intentionally unexposed) add the\n` +
    `names to the ALLOWLIST in scripts/check-sdk-coverage.mjs with a comment\n` +
    `explaining why.`,
);
process.exit(1);
