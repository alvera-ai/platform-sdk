import { Command } from 'commander';
import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  getProfileName,
  resolveProfile,
  writeProfileConfig,
} from '../config.js';
import { type GlobalOpts, die, out } from './helpers.js';

const ENVIRONMENT_NAMES = Object.keys(ENVIRONMENTS);

export function register(program: Command): void {
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
}
