#!/usr/bin/env tsx

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { ValiError } from 'valibot';
import { createPlatformApi, createSession, revokeSession } from './client.js';

const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const { version: packageVersion } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  version: string;
};
import {
  CONFIG_PATHS,
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  clearProfileCreds,
  getProfileName,
  readProfileConfig,
  resolveProfile,
  writeProfileConfig,
  writeProfileCreds,
} from './config.js';

const ENVIRONMENT_NAMES = Object.keys(ENVIRONMENTS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function die(message: string, code = 1): never {
  process.stderr.write(`alvera: ${message}\n`);
  process.exit(code);
}

async function prompt(question: string, { hidden = false } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (!hidden) {
    return new Promise((resolve) => rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    }));
  }
  // Hidden input — mute output by replacing _writeToOutput.
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

function readBody(body: string | undefined, bodyFile: string | undefined): Record<string, unknown> {
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

function resolveTenant(explicit: string | undefined, profileTenant: string | null): string {
  const tenant = explicit ?? profileTenant;
  if (!tenant) die('tenant slug required (pass as argument or set `tenant_slug` in the profile)');
  return tenant;
}

interface GlobalOpts {
  profile?: string;
  env?: string;
}

function authedApi(opts: GlobalOpts) {
  const profile = getProfileName(opts.profile);
  const resolved = resolveProfile(profile);
  if (!resolved.sessionToken) {
    die(
      `no session token for profile "${profile}". ` +
        `Run \`alvera login --profile ${profile}\` or set ALVERA_SESSION_TOKEN.`,
    );
  }
  if (resolved.expiresAt && new Date(resolved.expiresAt) < new Date()) {
    die(
      `session for profile "${profile}" expired at ${resolved.expiresAt}. ` +
        `Run \`alvera login --profile ${profile}\` to refresh.`,
    );
  }
  return { api: createPlatformApi({ baseUrl: resolved.baseUrl, sessionToken: resolved.sessionToken }), resolved };
}

async function run(fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    if (result !== undefined) out(result);
  } catch (err) {
    die(formatError(err));
  }
}

function formatError(err: unknown): string {
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

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name('alvera')
  .description('Alvera platform CLI')
  .version(packageVersion, '-v, --version', 'print the installed version')
  .addOption(new Option('--profile <name>', 'config profile to use').default('default'))
  .addOption(
    new Option(
      '--env <name>',
      `environment from spec/openapi.yaml (${ENVIRONMENT_NAMES.join(', ')})`,
    ),
  )
  .showHelpAfterError()
  .hook('preAction', (thisCommand) => {
    const env = thisCommand.optsWithGlobals<GlobalOpts>().env;
    if (env !== undefined) process.env.ALVERA_ENV = env;
    const candidate = process.env.ALVERA_ENV;
    if (candidate !== undefined && !ENVIRONMENT_NAMES.includes(candidate)) {
      die(
        `unknown environment "${candidate}". Valid: ${ENVIRONMENT_NAMES.join(', ')}`,
      );
    }
  });

// -- configure --------------------------------------------------------------
program
  .command('configure')
  .description('Interactively set defaults (environment, tenant, email) for a profile')
  .action(async () => {
    const profile = getProfileName(program.opts<GlobalOpts>().profile);
    const current = resolveProfile(profile);
    const currentCfg = readProfileConfig(profile);

    const options = ENVIRONMENT_NAMES.map(
      (name) => `${name} (${ENVIRONMENTS[name as keyof typeof ENVIRONMENTS].base_url})`,
    ).join(', ');
    const defaultChoice = currentCfg.environment ?? current.environment;
    const envInput =
      (await prompt(`Environment [${defaultChoice}] — one of: ${options}, or a custom URL: `)) ||
      defaultChoice;

    const patch: { environment?: string; base_url?: string; tenant_slug?: string; email?: string } = {};
    const unset: Array<'environment' | 'base_url'> = [];
    if (ENVIRONMENT_NAMES.includes(envInput)) {
      patch.environment = envInput;
      unset.push('base_url');
    } else if (/^https?:\/\//.test(envInput)) {
      patch.base_url = envInput;
      unset.push('environment');
    } else {
      die(
        `"${envInput}" is not a known environment or a URL. ` +
          `Valid: ${ENVIRONMENT_NAMES.join(', ')} or http(s)://…`,
      );
    }

    patch.tenant_slug =
      (await prompt(`Default tenant slug [${current.tenantSlug ?? ''}]: `)) || current.tenantSlug || '';
    patch.email = (await prompt(`Email [${current.email ?? ''}]: `)) || current.email || '';
    writeProfileConfig(profile, patch, unset);
    process.stderr.write(`Saved profile "${profile}" → ${CONFIG_PATHS.config}\n`);
  });

// -- login ------------------------------------------------------------------
program
  .command('login')
  .description('Exchange credentials for a session token and store it')
  .option('--email <email>')
  .option('--password <password>')
  .option('--tenant <slug>')
  .option('--base-url <url>')
  .option('--expires-in <seconds>', 'session duration (default 86400, max 2592000)')
  .action(async (opts: Record<string, string>) => {
    const profile = getProfileName(program.opts<GlobalOpts>().profile);
    const current = resolveProfile(profile);
    const baseUrl = opts.baseUrl ?? current.baseUrl;
    const email = opts.email ?? current.email ?? (await prompt('Email: '));
    const password = opts.password ?? process.env.ALVERA_PASSWORD ?? (await prompt('Password: ', { hidden: true }));
    const tenant = opts.tenant ?? current.tenantSlug ?? (await prompt('Tenant slug: '));
    if (!email || !password || !tenant) die('email, password, and tenant are required');

    await run(async () => {
      const session = await createSession({
        baseUrl,
        email,
        password,
        tenantSlug: tenant,
        expiresIn: opts.expiresIn ? Number(opts.expiresIn) : undefined,
      });
      // Only pin base_url into the profile when the user explicitly overrode it.
      // Otherwise the environment selection (profile.environment) keeps driving baseUrl.
      writeProfileConfig(profile, {
        ...(opts.baseUrl ? { base_url: baseUrl } : {}),
        tenant_slug: tenant,
        email,
      });
      writeProfileCreds(profile, {
        session_token: session.sessionToken,
        expires_at: session.expiresAt ?? '',
      });
      process.stderr.write(
        `Logged in as ${email} → tenant "${session.tenant.slug}" (profile "${profile}").\n` +
          `Token stored in ${CONFIG_PATHS.credentials}\n` +
          (session.expiresAt ? `Expires at ${session.expiresAt}\n` : ''),
      );
      return undefined;
    });
  });

// -- logout -----------------------------------------------------------------
program
  .command('logout')
  .description('Revoke the current session and clear stored credentials')
  .action(async () => {
    const profile = getProfileName(program.opts<GlobalOpts>().profile);
    const resolved = resolveProfile(profile);
    if (resolved.sessionToken) {
      createPlatformApi({ baseUrl: resolved.baseUrl, sessionToken: resolved.sessionToken });
      try {
        await revokeSession();
      } catch {
        // Token may already be invalid/expired — clear local state anyway.
      }
    }
    clearProfileCreds(profile);
    process.stderr.write(`Cleared credentials for profile "${profile}".\n`);
  });

// -- whoami -----------------------------------------------------------------
program
  .command('whoami')
  .description('Print the current profile configuration')
  .action(() => {
    const profile = getProfileName(program.opts<GlobalOpts>().profile);
    const resolved = resolveProfile(profile);
    out({
      profile: resolved.profile,
      environment: resolved.environment,
      baseUrl: resolved.baseUrl,
      tenantSlug: resolved.tenantSlug,
      email: resolved.email,
      hasSessionToken: Boolean(resolved.sessionToken),
      expiresAt: resolved.expiresAt,
    });
  });

// -- ping -------------------------------------------------------------------
program
  .command('ping')
  .description('Health check')
  .action(async () => {
    await run(async () => {
      const { api } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.ping();
      return data;
    });
  });

// -- env --------------------------------------------------------------------
// Environments are baked from spec/openapi.yaml servers[] at build time.
// Default (prod / or last-in-list) is chosen in scripts/gen-environments.mjs.
const envCmd = program
  .command('env')
  .description('List and switch Alvera API environments');

envCmd
  .command('list')
  .description('List available environments (from spec/openapi.yaml)')
  .action(() => {
    const profile = getProfileName(program.opts<GlobalOpts>().profile);
    const resolved = resolveProfile(profile);
    out(
      ENVIRONMENT_NAMES.map((name) => ({
        name,
        baseUrl: ENVIRONMENTS[name as keyof typeof ENVIRONMENTS].base_url,
        description: ENVIRONMENTS[name as keyof typeof ENVIRONMENTS].description,
        default: name === DEFAULT_ENVIRONMENT,
        active: name === resolved.environment,
      })),
    );
  });

envCmd
  .command('use <name>')
  .description('Persist the selected environment to the profile (clears any custom base_url)')
  .action((name: string) => {
    if (!ENVIRONMENT_NAMES.includes(name)) {
      die(`unknown environment "${name}". Valid: ${ENVIRONMENT_NAMES.join(', ')}`);
    }
    const profile = getProfileName(program.opts<GlobalOpts>().profile);
    writeProfileConfig(profile, { environment: name }, ['base_url']);
    process.stderr.write(
      `Profile "${profile}" now uses environment "${name}" ` +
        `(${ENVIRONMENTS[name as keyof typeof ENVIRONMENTS].base_url}).\n`,
    );
  });

// -- tenants ----------------------------------------------------------------
const tenants = program.command('tenants').description('Manage tenants');

tenants
  .command('list')
  .description('List tenants accessible to the current session')
  .action(async () => {
    await run(async () => {
      const { api } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.tenants.list();
      return data;
    });
  });

// ---------------------------------------------------------------------------
// Resource commands — thin wrappers over the SDK
// ---------------------------------------------------------------------------

const bodyOption = (cmd: Command): Command =>
  cmd
    .option('--body <json>', 'request body as a JSON string')
    .option('--body-file <path>', 'path to a JSON file (or "-" for stdin)');

// -- datalakes --------------------------------------------------------------
const datalakes = program.command('datalakes').description('Manage datalakes');

datalakes
  .command('list [tenant]')
  .description('List datalakes for a tenant')
  .action(async (tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.datalakes.list(resolveTenant(tenant, resolved.tenantSlug));
      return data;
    });
  });

datalakes
  .command('get <id> [tenant]')
  .description('Get a datalake by id')
  .action(async (id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.datalakes.get(resolveTenant(tenant, resolved.tenantSlug), id);
      return data;
    });
  });

// -- data-sources -----------------------------------------------------------
const dataSources = program.command('data-sources').description('Manage data sources');

dataSources
  .command('list <datalake> [tenant]')
  .description('List data sources in a datalake')
  .action(async (datalake: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataSources.list(resolveTenant(tenant, resolved.tenantSlug), datalake);
      return data;
    });
  });

bodyOption(dataSources.command('create <datalake> [tenant]').description('Create a data source'))
  .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataSources.create(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

bodyOption(dataSources.command('update <datalake> <id> [tenant]').description('Update a data source'))
  .action(async (datalake: string, id: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataSources.update(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        id,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

// -- tools ------------------------------------------------------------------
const tools = program.command('tools').description('Manage tools');

tools
  .command('list [tenant]')
  .description('List tools for a tenant')
  .action(async (tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.tools.list(resolveTenant(tenant, resolved.tenantSlug));
      return data;
    });
  });

tools
  .command('get <id> [tenant]')
  .description('Get a tool by id')
  .action(async (id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.tools.get(resolveTenant(tenant, resolved.tenantSlug), id);
      return data;
    });
  });

bodyOption(tools.command('create [tenant]').description('Create a tool'))
  .action(async (tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.tools.create(
        resolveTenant(tenant, resolved.tenantSlug),
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

bodyOption(tools.command('update <id> [tenant]').description('Update a tool'))
  .action(async (id: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.tools.update(
        resolveTenant(tenant, resolved.tenantSlug),
        id,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

tools
  .command('delete <id> [tenant]')
  .description('Delete a tool')
  .action(async (id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.tools.delete(resolveTenant(tenant, resolved.tenantSlug), id);
      return data;
    });
  });

// -- generic-tables ---------------------------------------------------------
const genericTables = program.command('generic-tables').description('Manage generic tables');

genericTables
  .command('list <datalake> [tenant]')
  .description('List generic tables in a datalake')
  .action(async (datalake: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.genericTables.list(resolveTenant(tenant, resolved.tenantSlug), datalake);
      return data;
    });
  });

bodyOption(genericTables.command('create <datalake> [tenant]').description('Create a generic table'))
  .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.genericTables.create(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        readBody(opts.body, opts.bodyFile) as never,
      );
      return data;
    });
  });

// -- action-status-updaters -------------------------------------------------
const updaters = program.command('action-status-updaters').description('Manage action status updaters');

updaters
  .command('list [tenant]')
  .description('List action status updaters')
  .action(async (tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.actionStatusUpdaters.list(resolveTenant(tenant, resolved.tenantSlug));
      return data;
    });
  });

bodyOption(updaters.command('create [tenant]').description('Create an action status updater'))
  .action(async (tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.actionStatusUpdaters.create(
        resolveTenant(tenant, resolved.tenantSlug),
        readBody(opts.body, opts.bodyFile) as never,
      );
      return data;
    });
  });

bodyOption(updaters.command('update <id> [tenant]').description('Update an action status updater'))
  .action(async (id: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.actionStatusUpdaters.update(
        resolveTenant(tenant, resolved.tenantSlug),
        id,
        readBody(opts.body, opts.bodyFile) as never,
      );
      return data;
    });
  });

// -- ai-agents --------------------------------------------------------------
const aiAgents = program.command('ai-agents').description('Manage AI agents');

aiAgents
  .command('list <datalake> [tenant]')
  .description('List AI agents in a datalake')
  .action(async (datalake: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.aiAgents.list(resolveTenant(tenant, resolved.tenantSlug), datalake);
      return data;
    });
  });

aiAgents
  .command('get <datalake> <id> [tenant]')
  .description('Get an AI agent by id')
  .action(async (datalake: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.aiAgents.get(resolveTenant(tenant, resolved.tenantSlug), datalake, id);
      return data;
    });
  });

bodyOption(aiAgents.command('create <datalake> [tenant]').description('Create an AI agent'))
  .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.aiAgents.create(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        readBody(opts.body, opts.bodyFile) as never,
      );
      return data;
    });
  });

bodyOption(aiAgents.command('update <datalake> <id> [tenant]').description('Update an AI agent'))
  .action(async (datalake: string, id: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.aiAgents.update(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        id,
        readBody(opts.body, opts.bodyFile) as never,
      );
      return data;
    });
  });

aiAgents
  .command('delete <datalake> <id> [tenant]')
  .description('Delete an AI agent')
  .action(async (datalake: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.aiAgents.delete(resolveTenant(tenant, resolved.tenantSlug), datalake, id);
      return data;
    });
  });

// -- session verify (via API) ----------------------------------------------
program
  .command('sessions-verify')
  .description('Verify the current session token via the API')
  .action(async () => {
    await run(async () => {
      const { api } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.sessions.verify();
      return data;
    });
  });

// -- datasets ---------------------------------------------------------------
const datasets = program.command('datasets').description('Search datasets');

datasets
  .command('search <dataset>')
  .description('Search a dataset (e.g. patient, member)')
  .option('--datalake-id <id>', 'restrict to a specific datalake')
  .option('--page <n>', 'page number', (v) => Number(v))
  .option('--page-size <n>', 'results per page (max 100)', (v) => Number(v))
  .action(async (dataset: string, opts: Record<string, unknown>) => {
    await run(async () => {
      const { api } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.datasets.search(dataset, {
        datalakeId: opts.datalakeId as string | undefined,
        page: opts.page as number | undefined,
        pageSize: opts.pageSize as number | undefined,
      });
      return data;
    });
  });

// -- datalakes create (extension) ------------------------------------------
bodyOption(datalakes.command('create [tenant]').description('Create a datalake'))
  .action(async (tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.datalakes.create(
        resolveTenant(tenant, resolved.tenantSlug),
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

// -- connected-apps (datalake-scoped management + tenant-scoped actions) ---
const connectedApps = program.command('connected-apps').description('Manage connected apps');

connectedApps
  .command('list <datalake> [tenant]')
  .description('List connected apps in a datalake')
  .action(async (datalake: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.connectedApps.list(resolveTenant(tenant, resolved.tenantSlug), datalake);
      return data;
    });
  });

connectedApps
  .command('get <datalake> <id> [tenant]')
  .description('Get a connected app by id')
  .action(async (datalake: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.connectedApps.get(resolveTenant(tenant, resolved.tenantSlug), datalake, id);
      return data;
    });
  });

bodyOption(connectedApps.command('create <datalake> [tenant]').description('Create a connected app'))
  .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.connectedApps.create(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

bodyOption(connectedApps.command('update <datalake> <id> [tenant]').description('Update a connected app'))
  .action(async (datalake: string, id: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.connectedApps.update(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        id,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

connectedApps
  .command('sync-routes <datalake> <id> [tenant]')
  .description('Trigger a sync of routes for a connected app')
  .action(async (datalake: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.connectedApps.syncRoutes(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        id,
      );
      return data;
    });
  });

bodyOption(
  connectedApps
    .command('resolve-page <slug> [tenant]')
    .description('Resolve a connected app page (tenant-scoped, by slug)'),
)
  .action(async (slug: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.connectedApps.resolvePage(
        resolveTenant(tenant, resolved.tenantSlug),
        slug,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

bodyOption(
  connectedApps
    .command('update-message-tracking <slug> [tenant]')
    .description('Update page message tracking for a connected app'),
)
  .action(async (slug: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.connectedApps.updateMessageTracking(
        resolveTenant(tenant, resolved.tenantSlug),
        slug,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

// -- data-activation-clients -----------------------------------------------
const dac = program.command('data-activation-clients').description('Manage data activation clients');

dac
  .command('list <datalake> [tenant]')
  .description('List data activation clients in a datalake')
  .action(async (datalake: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataActivationClients.list(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
      );
      return data;
    });
  });

dac
  .command('get <datalake> <slug> [tenant]')
  .description('Get a data activation client by slug')
  .action(async (datalake: string, slug: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataActivationClients.get(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
      );
      return data;
    });
  });

bodyOption(dac.command('create <datalake> [tenant]').description('Create a data activation client'))
  .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataActivationClients.create(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

bodyOption(dac.command('update <datalake> <slug> [tenant]').description('Update a data activation client'))
  .action(async (datalake: string, slug: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataActivationClients.update(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

dac
  .command('delete <datalake> <slug> [tenant]')
  .description('Delete a data activation client')
  .action(async (datalake: string, slug: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataActivationClients.delete(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
      );
      return data;
    });
  });

dac
  .command('metadata <datalake> <slug> [tenant]')
  .description('Get markdown metadata for a data activation client')
  .action(async (datalake: string, slug: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataActivationClients.metadata(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
      );
      return data;
    });
  });

bodyOption(
  dac
    .command('run-manually <datalake> <slug> [tenant]')
    .description('Trigger a manual run (optional --body for tool_call override)'),
)
  .action(async (datalake: string, slug: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const body = opts.body || opts.bodyFile ? readBody(opts.body, opts.bodyFile) : undefined;
      const { data } = await api.dataActivationClients.runManually(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
        body,
      );
      return data;
    });
  });

bodyOption(dac.command('ingest <datalake> <slug> [tenant]').description('Ingest a JSON payload'))
  .action(async (datalake: string, slug: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataActivationClients.ingest(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

dac
  .command('ingest-file <datalake> <slug> <key> [tenant]')
  .description('Ingest a previously uploaded file (key from upload-link)')
  .action(async (datalake: string, slug: string, key: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataActivationClients.ingestFile(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
        { key },
      );
      return data;
    });
  });

dac
  .command('logs <datalake> <slug> [tenant]')
  .description('List execution logs for a data activation client')
  .action(async (datalake: string, slug: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataActivationClients.logs.list(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
      );
      return data;
    });
  });

dac
  .command('log-get <datalake> <slug> <id> [tenant]')
  .description('Get a single execution log by id')
  .action(async (datalake: string, slug: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataActivationClients.logs.get(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
        id,
      );
      return data;
    });
  });

datalakes
  .command('upload-link <datalake> <filename> [tenant]')
  .description('Create a presigned upload link for a datalake')
  .addOption(
    new Option('--content-type <type>', 'MIME type of the file')
      .choices(['application/x-ndjson', 'text/csv'])
      .default('application/x-ndjson'),
  )
  .action(
    async (
      datalake: string,
      filename: string,
      tenant: string | undefined,
      opts: Record<string, string>,
    ) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.datalakes.createUploadLink(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          {
            content_type: opts.contentType as 'application/x-ndjson' | 'text/csv',
            filename,
          },
        );
        return data;
      });
    },
  );

datalakes
  .command('download-link <datalake> <bucket> <key> [tenant]')
  .description('Create a presigned download URL for a datalake object')
  .action(
    async (
      datalake: string,
      bucket: string,
      key: string,
      tenant: string | undefined,
    ) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.datalakes.createDownloadLink(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          { bucket, key },
        );
        return data;
      });
    },
  );

// -- mdm --------------------------------------------------------------------
const mdm = program.command('mdm').description('Master data management');

bodyOption(
  mdm.command('verify <datalake> [tenant]').description('Fuzzy-verify an identity against MDM'),
)
  .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.mdm.verify(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

// -- datalakes metadata + datasets metadata --------------------------------
datalakes
  .command('metadata <datalake> [tenant]')
  .description('Get markdown metadata for a datalake')
  .action(async (datalake: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.datalakes.metadata(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
      );
      return data;
    });
  });

datasets
  .command('metadata <dataset-type>')
  .description('Get markdown schema metadata for a dataset type')
  .option('--datalake-id <id>', 'restrict to a specific datalake')
  .option('--generic-table-id <id>', 'required when dataset-type is generic_table')
  .action(async (datasetType: string, opts: Record<string, string>) => {
    await run(async () => {
      const { api } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.datasets.metadata(datasetType, {
        datalakeId: opts.datalakeId,
        genericTableId: opts.genericTableId,
      });
      return data;
    });
  });

// -- interoperability-contracts --------------------------------------------
const interop = program
  .command('interoperability-contracts')
  .alias('interop')
  .description('Manage interoperability contracts');

interop
  .command('list <datalake> [tenant]')
  .description('List interoperability contracts in a datalake')
  .action(async (datalake: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.interoperabilityContracts.list(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
      );
      return data;
    });
  });

interop
  .command('get <datalake> <slug> [tenant]')
  .description('Get a contract by slug')
  .action(async (datalake: string, slug: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.interoperabilityContracts.get(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
      );
      return data;
    });
  });

bodyOption(interop.command('create <datalake> [tenant]').description('Create a contract'))
  .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.interoperabilityContracts.create(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

bodyOption(interop.command('update <datalake> <slug> [tenant]').description('Update a contract'))
  .action(async (datalake: string, slug: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.interoperabilityContracts.update(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

interop
  .command('delete <datalake> <slug> [tenant]')
  .description('Delete a contract')
  .action(async (datalake: string, slug: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.interoperabilityContracts.delete(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
      );
      return data;
    });
  });

interop
  .command('metadata <datalake> <slug> [tenant]')
  .description('Get markdown metadata for a contract')
  .action(async (datalake: string, slug: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.interoperabilityContracts.metadata(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
      );
      return data;
    });
  });

bodyOption(
  interop
    .command('run <datalake> <slug> [tenant]')
    .description('Execute a contract against a raw source row'),
)
  .action(async (datalake: string, slug: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.interoperabilityContracts.run(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        slug,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

// -- workflows --------------------------------------------------------------
const workflows = program.command('workflows').description('Agentic workflows');

workflows
  .command('list <datalake> [tenant]')
  .description('List workflow definitions in a datalake')
  .action(async (datalake: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.list(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
      );
      return data;
    });
  });

workflows
  .command('get <datalake> <id> [tenant]')
  .description('Get a workflow by id')
  .action(async (datalake: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.get(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        id,
      );
      return data;
    });
  });

bodyOption(workflows.command('create <datalake> [tenant]').description('Create a workflow'))
  .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.create(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

bodyOption(workflows.command('update <datalake> <id> [tenant]').description('Update a workflow'))
  .action(async (datalake: string, id: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.update(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        id,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

workflows
  .command('delete <datalake> <id> [tenant]')
  .description('Delete a workflow')
  .action(async (datalake: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.delete(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        id,
      );
      return data;
    });
  });

workflows
  .command('metadata <datalake> <id> [tenant]')
  .description('Get markdown metadata for a workflow')
  .action(async (datalake: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.metadata(
        resolveTenant(tenant, resolved.tenantSlug),
        datalake,
        id,
      );
      return data;
    });
  });

bodyOption(
  workflows.command('execute <workflow-slug> [tenant]').description('Execute an agentic workflow'),
)
  .action(async (workflowSlug: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.execute(
        resolveTenant(tenant, resolved.tenantSlug),
        workflowSlug,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

bodyOption(
  workflows
    .command('run <workflow-slug> [tenant]')
    .description('Run a workflow across records matched by a SQL WHERE clause'),
)
  .action(async (workflowSlug: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.run(
        resolveTenant(tenant, resolved.tenantSlug),
        workflowSlug,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

workflows
  .command('batch-logs <workflow-slug> [tenant]')
  .description('List batch logs for a workflow')
  .action(async (workflowSlug: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.batchLogs.list(
        resolveTenant(tenant, resolved.tenantSlug),
        workflowSlug,
      );
      return data;
    });
  });

workflows
  .command('batch-log <workflow-slug> <id> [tenant]')
  .description('Get a single batch log by id')
  .action(async (workflowSlug: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.batchLogs.get(
        resolveTenant(tenant, resolved.tenantSlug),
        workflowSlug,
        id,
      );
      return data;
    });
  });

workflows
  .command('batch-log-start <workflow-slug> <id> [tenant]')
  .description('Start polling a batch log')
  .action(async (workflowSlug: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.batchLogs.start(
        resolveTenant(tenant, resolved.tenantSlug),
        workflowSlug,
        id,
      );
      return data;
    });
  });

workflows
  .command('batch-log-stop <workflow-slug> <id> [tenant]')
  .description('Stop polling a batch log')
  .action(async (workflowSlug: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.batchLogs.stop(
        resolveTenant(tenant, resolved.tenantSlug),
        workflowSlug,
        id,
      );
      return data;
    });
  });

workflows
  .command('batch-log-refresh <workflow-slug> <id> [tenant]')
  .description('Force-refresh a batch log')
  .action(async (workflowSlug: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.batchLogs.refresh(
        resolveTenant(tenant, resolved.tenantSlug),
        workflowSlug,
        id,
      );
      return data;
    });
  });

workflows
  .command('workflow-logs <workflow-slug> [tenant]')
  .description('List execution logs for a workflow')
  .action(async (workflowSlug: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.workflowLogs.list(
        resolveTenant(tenant, resolved.tenantSlug),
        workflowSlug,
      );
      return data;
    });
  });

workflows
  .command('workflow-log <workflow-slug> <id> [tenant]')
  .description('Get a single execution log by id')
  .action(async (workflowSlug: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.workflowLogs.get(
        resolveTenant(tenant, resolved.tenantSlug),
        workflowSlug,
        id,
      );
      return data;
    });
  });

workflows
  .command('workflow-log-download <workflow-slug> <id> [tenant]')
  .description('Get a presigned download URL for an execution log')
  .action(async (workflowSlug: string, id: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.workflows.workflowLogs.download(
        resolveTenant(tenant, resolved.tenantSlug),
        workflowSlug,
        id,
      );
      return data;
    });
  });

program.parseAsync();
