import { Command } from 'commander';
import { createSession, createUnvalidatedPlatformApi, revokeSession } from '../client.js';
import {
  CONFIG_PATHS,
  ENVIRONMENTS,
  clearProfileCreds,
  getProfileName,
  readProfileConfig,
  resolveProfile,
  writeProfileConfig,
  writeProfileCreds,
} from '../config.js';
import { type GlobalOpts, authedApi, die, out, prompt, run } from './helpers.js';

const ENVIRONMENT_NAMES = Object.keys(ENVIRONMENTS);

export function register(program: Command): void {
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
        writeProfileConfig(profile, {
          ...(opts.baseUrl ? { base_url: baseUrl } : {}),
          tenant_slug: tenant,
          email,
        });
        clearProfileCreds(profile);
        writeProfileCreds(profile, {
          session_token: session.sessionToken,
          expires_at: session.expiresAt ?? '',
        });
        const tenantLabel = session.tenant ? `tenant "${session.tenant.slug}"` : 'no tenant';
        process.stderr.write(
          `Logged in as ${email} → ${tenantLabel} (profile "${profile}").\n` +
            `Token stored in ${CONFIG_PATHS.credentials}\n` +
            (session.expiresAt ? `Expires at ${session.expiresAt}\n` : ''),
        );
        return undefined;
      });
    });

  program
    .command('logout')
    .description('Revoke the current session and clear stored credentials')
    .action(async () => {
      const profile = getProfileName(program.opts<GlobalOpts>().profile);
      const resolved = resolveProfile(profile);
      if (resolved.sessionToken) {
        createUnvalidatedPlatformApi({ baseUrl: resolved.baseUrl, sessionToken: resolved.sessionToken });
        try {
          await revokeSession();
        } catch {
          // Token may already be invalid/expired — clear local state anyway.
        }
      }
      clearProfileCreds(profile);
      process.stderr.write(`Cleared credentials for profile "${profile}".\n`);
    });

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
        hasApiKey: Boolean(resolved.apiKey),
      });
    });

  program
    .command('set-api-key')
    .description('Store an API key for the current profile (used instead of session token)')
    .argument('[key]', 'API key (omit to read from prompt or ALVERA_API_KEY)')
    .action(async (key?: string) => {
      const profile = getProfileName(program.opts<GlobalOpts>().profile);
      const apiKey = key ?? process.env.ALVERA_API_KEY ?? (await prompt('API key: ', { hidden: true }));
      if (!apiKey) die('API key is required');
      clearProfileCreds(profile);
      writeProfileCreds(profile, { api_key: apiKey });
      process.stderr.write(
        `API key stored for profile "${profile}" → ${CONFIG_PATHS.credentials}\n` +
          `(session token cleared)\n`,
      );
    });

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
}
