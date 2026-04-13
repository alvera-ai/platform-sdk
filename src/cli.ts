#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Command, Option } from 'commander';
import { createPlatformApi, createSession, revokeSession } from './client.js';
import {
  CONFIG_PATHS,
  clearProfileCreds,
  getProfileName,
  resolveProfile,
  writeProfileConfig,
  writeProfileCreds,
} from './config.js';

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
    const message = err instanceof Error ? err.message : String(err);
    die(message);
  }
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name('alvera')
  .description('Alvera platform CLI')
  .addOption(new Option('--profile <name>', 'config profile to use').default('default'))
  .showHelpAfterError();

// -- configure --------------------------------------------------------------
program
  .command('configure')
  .description('Interactively set defaults (base URL, tenant) for a profile')
  .action(async () => {
    const profile = getProfileName(program.opts<GlobalOpts>().profile);
    const current = resolveProfile(profile);
    const baseUrl = (await prompt(`Base URL [${current.baseUrl}]: `)) || current.baseUrl;
    const tenantSlug =
      (await prompt(`Default tenant slug [${current.tenantSlug ?? ''}]: `)) || current.tenantSlug || '';
    const email = (await prompt(`Email [${current.email ?? ''}]: `)) || current.email || '';
    writeProfileConfig(profile, { base_url: baseUrl, tenant_slug: tenantSlug, email });
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
      writeProfileConfig(profile, { base_url: baseUrl, tenant_slug: tenant, email });
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
const dac = program.command('data-activation-clients').description('Data activation client actions');

bodyOption(dac.command('ingest <slug> [tenant]').description('Ingest a JSON payload'))
  .action(async (slug: string, tenant: string | undefined, opts: Record<string, string>) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataActivationClients.ingest(
        resolveTenant(tenant, resolved.tenantSlug),
        slug,
        readBody(opts.body, opts.bodyFile),
      );
      return data;
    });
  });

dac
  .command('ingest-file <slug> <key> [tenant]')
  .description('Ingest a previously uploaded file (key from upload-link)')
  .action(async (slug: string, key: string, tenant: string | undefined) => {
    await run(async () => {
      const { api, resolved } = authedApi(program.opts<GlobalOpts>());
      const { data } = await api.dataActivationClients.ingestFile(
        resolveTenant(tenant, resolved.tenantSlug),
        slug,
        { key },
      );
      return data;
    });
  });

dac
  .command('upload-link <slug> <filename> [tenant]')
  .description('Create a presigned upload link')
  .addOption(
    new Option('--content-type <type>', 'MIME type of the file')
      .choices(['application/x-ndjson', 'text/csv'])
      .default('application/x-ndjson'),
  )
  .action(
    async (
      slug: string,
      filename: string,
      tenant: string | undefined,
      opts: Record<string, string>,
    ) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataActivationClients.createUploadLink(
          resolveTenant(tenant, resolved.tenantSlug),
          slug,
          {
            content_type: opts.contentType as 'application/x-ndjson' | 'text/csv',
            filename,
          },
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

// -- workflows --------------------------------------------------------------
const workflows = program.command('workflows').description('Agentic workflows');

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

program.parseAsync();
