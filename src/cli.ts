#!/usr/bin/env tsx

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { ENVIRONMENTS } from './config.js';
import { die } from './cli/helpers.js';
import { register as registerAuth } from './cli/auth.js';
import { register as registerEnv } from './cli/env.js';
import { register as registerInit } from './cli/init.js';
import { register as registerRaw } from './cli/raw.js';
import { register as registerResources } from './cli/resources.js';
import { register as registerWorkflows } from './cli/workflows.js';

const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const { version: packageVersion } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  version: string;
};

const ENVIRONMENT_NAMES = Object.keys(ENVIRONMENTS);

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
    const env = thisCommand.optsWithGlobals<{ env?: string }>().env;
    if (env !== undefined) process.env.ALVERA_ENV = env;
    const candidate = process.env.ALVERA_ENV;
    if (candidate !== undefined && !ENVIRONMENT_NAMES.includes(candidate)) {
      die(
        `unknown environment "${candidate}". Valid: ${ENVIRONMENT_NAMES.join(', ')}`,
      );
    }
  });

registerAuth(program);
registerEnv(program);
registerInit(program);
registerRaw(program);
registerResources(program);
registerWorkflows(program);

program.parseAsync();
