import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  type EnvironmentName,
} from './environments.generated.js';

export { ENVIRONMENTS, DEFAULT_ENVIRONMENT, type EnvironmentName } from './environments.generated.js';

const CONFIG_DIR = join(homedir(), '.alvera-ai');
const CONFIG_FILE = join(CONFIG_DIR, 'config');
const CREDS_FILE = join(CONFIG_DIR, 'credentials');

export interface ProfileConfig {
  environment?: string;
  base_url?: string;
  tenant_slug?: string;
  email?: string;
}

export interface ProfileCreds {
  session_token?: string;
  expires_at?: string;
  api_key?: string;
}

export interface ResolvedProfile {
  profile: string;
  environment: EnvironmentName;
  baseUrl: string;
  tenantSlug: string | null;
  email: string | null;
  sessionToken: string | null;
  expiresAt: string | null;
  apiKey: string | null;
}

function isEnvironmentName(name: string): name is EnvironmentName {
  return Object.prototype.hasOwnProperty.call(ENVIRONMENTS, name);
}

function resolveEnvironment(cfg: ProfileConfig): EnvironmentName {
  const candidate = process.env.ALVERA_ENV ?? cfg.environment ?? DEFAULT_ENVIRONMENT;
  if (!isEnvironmentName(candidate)) {
    const valid = Object.keys(ENVIRONMENTS).join(', ');
    throw new Error(
      `Unknown environment "${candidate}". Valid environments: ${valid}.`,
    );
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Minimal INI parser / serializer. Handles [section] headers and key=value
// lines; ignores comments (# or ;) and blank lines.
// ---------------------------------------------------------------------------

type IniSections = Record<string, Record<string, string>>;

function parseIni(text: string): IniSections {
  const sections: IniSections = {};
  let current = 'default';
  sections[current] = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = header[1]!.trim();
      sections[current] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    sections[current]![key] = value;
  }
  return sections;
}

function serializeIni(sections: IniSections): string {
  const parts: string[] = [];
  const names = Object.keys(sections).sort((a, b) =>
    a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b),
  );
  for (const name of names) {
    const body = sections[name]!;
    if (Object.keys(body).length === 0) continue;
    parts.push(`[${name}]`);
    for (const [k, v] of Object.entries(body)) {
      parts.push(`${k} = ${v}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

function readIni(path: string): IniSections {
  if (!existsSync(path)) return {};
  return parseIni(readFileSync(path, 'utf8'));
}

function writeIni(path: string, sections: IniSections, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, serializeIni(sections), { mode });
  chmodSync(path, mode);
}

// ---------------------------------------------------------------------------
// Profile key helpers. AWS convention: [default] and [profile <name>] in
// config; [default] and [<name>] in credentials.
// ---------------------------------------------------------------------------

function configKey(profile: string): string {
  return profile === 'default' ? 'default' : `profile ${profile}`;
}

function credsKey(profile: string): string {
  return profile;
}

export function getProfileName(flag?: string): string {
  return flag ?? process.env.ALVERA_PROFILE ?? 'default';
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export function readProfileConfig(profile: string): ProfileConfig {
  const sections = readIni(CONFIG_FILE);
  return (sections[configKey(profile)] ?? {}) as ProfileConfig;
}

export function readProfileCreds(profile: string): ProfileCreds {
  const sections = readIni(CREDS_FILE);
  return (sections[credsKey(profile)] ?? {}) as ProfileCreds;
}

export function writeProfileConfig(
  profile: string,
  patch: ProfileConfig,
  unset: ReadonlyArray<keyof ProfileConfig> = [],
): void {
  const sections = readIni(CONFIG_FILE);
  const key = configKey(profile);
  const merged = { ...(sections[key] ?? {}), ...stripUndefined(patch as Record<string, unknown>) };
  for (const k of unset) delete merged[k as string];
  sections[key] = merged;
  writeIni(CONFIG_FILE, sections, 0o600);
}

export function writeProfileCreds(profile: string, patch: ProfileCreds): void {
  const sections = readIni(CREDS_FILE);
  const key = credsKey(profile);
  sections[key] = { ...(sections[key] ?? {}), ...stripUndefined(patch as Record<string, unknown>) };
  writeIni(CREDS_FILE, sections, 0o600);
}

export function clearProfileCreds(profile: string): void {
  const sections = readIni(CREDS_FILE);
  delete sections[credsKey(profile)];
  writeIni(CREDS_FILE, sections, 0o600);
}

function stripUndefined(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = String(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolve a profile: merge config + creds + env var overrides. Env vars take
// precedence (so scripts/CI can override without touching files).
// ---------------------------------------------------------------------------

export function resolveProfile(profile: string): ResolvedProfile {
  const cfg = readProfileConfig(profile);
  const creds = readProfileCreds(profile);
  const environment = resolveEnvironment(cfg);
  return {
    profile,
    environment,
    baseUrl:
      process.env.ALVERA_BASE_URL ??
      cfg.base_url ??
      ENVIRONMENTS[environment].base_url,
    tenantSlug:
      process.env.ALVERA_TENANT ?? cfg.tenant_slug ?? null,
    email: process.env.ALVERA_EMAIL ?? cfg.email ?? null,
    sessionToken:
      process.env.ALVERA_SESSION_TOKEN ?? creds.session_token ?? null,
    expiresAt: creds.expires_at ?? null,
    apiKey:
      process.env.ALVERA_API_KEY ?? creds.api_key ?? null,
  };
}

export const CONFIG_PATHS = {
  dir: CONFIG_DIR,
  config: CONFIG_FILE,
  credentials: CREDS_FILE,
};
