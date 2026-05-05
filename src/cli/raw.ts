import { Command } from 'commander';
import { getProfileName, resolveProfile } from '../config.js';
import { type GlobalOpts, bodyOption, die, out, readBody } from './helpers.js';

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export function register(program: Command): void {
  bodyOption(
    program
      .command('raw <method> <path>')
      .description('Send an authenticated HTTP request bypassing SDK validation')
      .option('--no-parse', 'print raw response text instead of pretty-printing JSON'),
  )
    .action(
      async (
        method: string,
        path: string,
        opts: { body?: string; bodyFile?: string; parse?: boolean },
      ) => {
        const upper = method.toUpperCase();
        if (!ALLOWED_METHODS.includes(upper as (typeof ALLOWED_METHODS)[number])) {
          die(`invalid method "${method}". Allowed: ${ALLOWED_METHODS.join(', ')}`);
        }

        const globalOpts = program.opts<GlobalOpts>();
        const profile = getProfileName(globalOpts.profile);
        const resolved = resolveProfile(profile);
        if (!resolved.sessionToken) {
          die(`no session token for profile "${profile}". Run \`alvera login\` first.`);
        }

        const url = `${resolved.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
        const headers: Record<string, string> = {
          Authorization: `Bearer ${resolved.sessionToken}`,
        };

        let fetchBody: string | undefined;
        if (opts.body || opts.bodyFile) {
          const parsed = readBody(opts.body, opts.bodyFile);
          fetchBody = JSON.stringify(parsed);
          headers['Content-Type'] = 'application/json';
        }

        const resp = await fetch(url, { method: upper, headers, body: fetchBody });
        const text = await resp.text();

        if (!resp.ok) {
          die(`${upper} ${path} → ${resp.status} ${resp.statusText}: ${text}`);
        }

        if (opts.parse === false) {
          process.stdout.write(text + '\n');
        } else {
          try {
            out(JSON.parse(text));
          } catch {
            process.stdout.write(text + '\n');
          }
        }
      },
    );
}
