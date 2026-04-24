#!/usr/bin/env node
// Derives src/environments.generated.ts from spec/openapi.yaml.
//
// Each entry in `servers[]` carries a `variables.key.default` (the short
// environment identifier) and a `url` (the base URL). We extract those into a
// typed ENVIRONMENTS map and pick DEFAULT_ENVIRONMENT as 'prod' if present,
// else the last server.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

interface ServerSpec {
  url?: unknown;
  description?: unknown;
  variables?: { key?: { default?: unknown } };
}

interface Entry {
  readonly key: string;
  readonly baseUrl: string;
  readonly description: string;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = resolve(root, 'spec/openapi.yaml');
const outPath = resolve(root, 'src/environments.generated.ts');

const spec = parse(readFileSync(specPath, 'utf8')) as { servers?: unknown };
const servers = spec?.servers;

if (!Array.isArray(servers) || servers.length === 0) {
  console.error(`gen-environments: no servers[] array in ${specPath}`);
  process.exit(1);
}

const entries: Entry[] = (servers as ServerSpec[]).map((server, idx): Entry => {
  const key = server?.variables?.key?.default;
  const baseUrl = server?.url;
  const description = server?.description ?? '';
  if (typeof key !== 'string' || !key) {
    console.error(
      `gen-environments: servers[${idx}] missing variables.key.default (got ${JSON.stringify(server?.variables)})`,
    );
    process.exit(1);
  }
  if (typeof baseUrl !== 'string' || !baseUrl) {
    console.error(`gen-environments: servers[${idx}] missing url`);
    process.exit(1);
  }
  return { key, baseUrl, description: String(description) };
});

const keys = entries.map((e) => e.key);
const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
if (dupes.length > 0) {
  console.error(
    `gen-environments: duplicate environment keys: ${[...new Set(dupes)].join(', ')}`,
  );
  process.exit(1);
}

const lastEntry = entries.at(-1);
if (!lastEntry) {
  console.error('gen-environments: entries empty after validation (unreachable)');
  process.exit(1);
}
const defaultEnv = entries.find((e) => e.key === 'prod')?.key ?? lastEntry.key;

const lines = [
  '// Generated from spec/openapi.yaml by scripts/gen-environments.ts — do not edit.',
  '',
  'export interface EnvironmentConfig {',
  '  readonly base_url: string;',
  '  readonly description: string;',
  '}',
  '',
  'export const ENVIRONMENTS = {',
  ...entries.map(
    (e) =>
      `  ${e.key}: { base_url: ${JSON.stringify(e.baseUrl)}, description: ${JSON.stringify(e.description)} },`,
  ),
  '} as const satisfies Readonly<Record<string, EnvironmentConfig>>;',
  '',
  `export const DEFAULT_ENVIRONMENT = ${JSON.stringify(defaultEnv)} as const;`,
  '',
  'export type EnvironmentName = keyof typeof ENVIRONMENTS;',
  '',
];

writeFileSync(outPath, lines.join('\n'));
console.log(
  `gen-environments: wrote ${outPath} (${entries.length} envs, default=${defaultEnv})`,
);
