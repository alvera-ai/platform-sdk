import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { ValiError } from 'valibot';
import { createUnvalidatedPlatformApi } from '../client.js';
import { getProfileName, resolveProfile } from '../config.js';

export interface GlobalOpts {
  profile?: string;
  env?: string;
}

export function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function die(message: string, code = 1): never {
  process.stderr.write(`alvera: ${message}\n`);
  process.exit(code);
}

export async function prompt(question: string, { hidden = false } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (!hidden) {
    return new Promise((resolve) => rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    }));
  }
  const anyRl = rl as unknown as { _writeToOutput: (s: string) => void };
  const originalWrite = anyRl._writeToOutput.bind(rl);
  anyRl._writeToOutput = (s: string) => {
    if (s.includes(question)) originalWrite(s);
    else originalWrite('');
  };
  return new Promise((resolve) => rl.question(question, (ans) => {
    rl.close();
    process.stderr.write('\n');
    resolve(ans);
  }));
}

export function readBody(body: string | undefined, bodyFile: string | undefined): Record<string, unknown> {
  if (body && bodyFile) die('use only one of --body or --body-file');
  let raw: string;
  if (body) raw = body;
  else if (bodyFile === '-') raw = readFileSync(0, 'utf8');
  else if (bodyFile) raw = readFileSync(bodyFile, 'utf8');
  else die('missing request body (pass --body <json> or --body-file <path>)');
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      die('body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    die(`invalid JSON in body: ${(err as Error).message}`);
  }
}

export function resolveTenant(explicit: string | undefined, profileTenant: string | null): string {
  const tenant = explicit ?? profileTenant;
  if (!tenant) die('tenant slug required (pass as argument or set `tenant_slug` in the profile)');
  return tenant;
}

export function authedApi(opts: GlobalOpts) {
  const profile = getProfileName(opts.profile);
  const resolved = resolveProfile(profile);

  if (resolved.apiKey) {
    return {
      api: createUnvalidatedPlatformApi({ baseUrl: resolved.baseUrl, apiKey: resolved.apiKey }),
      resolved,
    };
  }

  if (!resolved.sessionToken) {
    die(
      `no credentials for profile "${profile}". ` +
        `Run \`alvera login --profile ${profile}\`, set ALVERA_SESSION_TOKEN, or set ALVERA_API_KEY.`,
    );
  }
  if (resolved.expiresAt && new Date(resolved.expiresAt) < new Date()) {
    die(
      `session for profile "${profile}" expired at ${resolved.expiresAt}. ` +
        `Run \`alvera login --profile ${profile}\` to refresh.`,
    );
  }
  return {
    api: createUnvalidatedPlatformApi({ baseUrl: resolved.baseUrl, sessionToken: resolved.sessionToken }),
    resolved,
  };
}

export async function run(fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    if (result !== undefined) out(result);
  } catch (err) {
    die(formatError(err));
  }
}

export function formatError(err: unknown): string {
  if (err instanceof ValiError) {
    const lines = err.issues.map((issue) => {
      const path = (issue.path ?? [])
        .map((p: { key?: unknown }) => String(p.key ?? '?'))
        .join('.') || '(root)';
      return `  ${path}: ${issue.message}`;
    });
    return `validation failed:\n${lines.join('\n')}`;
  }
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const detail = (err as { errors?: { detail?: unknown } }).errors?.detail;
    if (typeof detail === 'string') return detail;
    return JSON.stringify(err, null, 2);
  }
  return String(err);
}

export function bodyOption(cmd: Command): Command {
  return cmd
    .option('--body <json>', 'request body as a JSON string')
    .option('--body-file <path>', 'path to a JSON file (or "-" for stdin)');
}
