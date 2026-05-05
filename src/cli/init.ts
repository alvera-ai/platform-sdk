import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { Command } from 'commander';

interface InitField {
  key: string;
  label: string;
  default?: string;
}
type InitSection = { header: string; fields: InitField[] }

const DB_KEYS = ['HOST', 'PORT', 'NAME', 'SCHEMA', 'AUTH_METHOD', 'USER', 'PASS', 'ENABLE_SSL'] as const;
const DB_LABELS = ['host', 'port', 'database name', 'schema', 'auth method', 'user', 'password', 'enable SSL'] as const;
const DB_DEFAULTS: Record<string, string> = { PORT: '5432', SCHEMA: 'public', AUTH_METHOD: 'password', ENABLE_SSL: 'false' };

function dbSection(label: string, prefix: string): InitSection {
  return {
    header: label,
    fields: DB_KEYS.map((k, i) => ({
      key: `${prefix}_${k}`,
      label: `${label} — ${DB_LABELS[i]}`,
      default: DB_DEFAULTS[k],
    })),
  };
}

const STORAGE_KEYS = ['TYPE', 'REGION', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'ENDPOINT', 'BUCKET'] as const;
const STORAGE_LABELS = ['type (aws/r2)', 'region', 'access key ID', 'secret access key', 'endpoint', 'bucket'] as const;

function storageSection(label: string, prefix: string): InitSection {
  return {
    header: label,
    fields: STORAGE_KEYS.map((k, i) => ({
      key: `${prefix}_${k}`,
      label: `${label} — ${STORAGE_LABELS[i]}`,
      default: k === 'TYPE' ? 'aws' : undefined,
    })),
  };
}

async function collectAndWrite(sections: InitSection[], outPath: string): Promise<void> {
  const allFields = sections.flatMap((s) => s.fields);

  let answers: string[];
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const ask = (q: string): Promise<string> =>
      new Promise((res) => rl.question(q, (ans) => res(ans)));
    answers = [];
    for (const field of allFields) {
      const dflt = field.default ?? '';
      const suffix = dflt ? ` [${dflt}]` : '';
      answers.push(await ask(`${field.label}${suffix}: `));
    }
    rl.close();
  } else {
    const raw = readFileSync(0, 'utf8');
    answers = raw.split('\n');
  }

  const lines: string[] = [];
  let idx = 0;
  for (const section of sections) {
    if (lines.length > 0) lines.push('');
    lines.push(`# ${section.header}`);
    for (const field of section.fields) {
      const dflt = field.default ?? '';
      const answer = (answers[idx++] ?? '').trim();
      lines.push(`${field.key}=${answer || dflt}`);
    }
  }

  const abs = resolve(process.cwd(), outPath);
  writeFileSync(abs, lines.join('\n') + '\n');
  process.stderr.write(`Wrote ${abs}\n`);
}

export function register(program: Command): void {
  const initCmd = program.command('init').description('Generate a .env configuration file');

  initCmd
    .command('connected-app')
    .description('Generate .env for SDK / connected-app integration')
    .option('-o, --output <path>', 'output file path', '.env')
    .action(async (opts: { output: string }) => {
      await collectAndWrite([
        {
          header: 'Alvera connected-app configuration',
          fields: [
            { key: 'ALVERA_BASE_URL', label: 'Base URL', default: 'https://api.alvera.ai' },
            { key: 'ALVERA_TENANT', label: 'Tenant slug' },
            { key: 'ALVERA_DATALAKE', label: 'Datalake slug' },
            { key: 'ALVERA_CONNECTED_APP', label: 'Connected app slug' },
          ],
        },
      ], opts.output);
    });

  initCmd
    .command('infra-setup')
    .description('Generate .env for datalake infrastructure (databases + object storage)')
    .option('-o, --output <path>', 'output file path', '.env')
    .action(async (opts: { output: string }) => {
      await collectAndWrite([
        {
          header: 'Datalake',
          fields: [
            { key: 'ALVERA_DATALAKE_NAME', label: 'Datalake name' },
            { key: 'ALVERA_DATALAKE_DATA_DOMAIN', label: 'Data domain' },
            { key: 'ALVERA_DATALAKE_TIMEZONE', label: 'Timezone', default: 'UTC' },
            { key: 'ALVERA_DATALAKE_POOL_SIZE', label: 'Pool size', default: '10' },
          ],
        },
        dbSection('Database — Unregulated Reader', 'ALVERA_DB_UNREG_READER'),
        dbSection('Database — Unregulated Writer', 'ALVERA_DB_UNREG_WRITER'),
        dbSection('Database — Regulated Reader', 'ALVERA_DB_REG_READER'),
        dbSection('Database — Regulated Writer', 'ALVERA_DB_REG_WRITER'),
        storageSection('Storage — Unregulated', 'ALVERA_STORAGE_UNREG'),
        storageSection('Storage — Regulated', 'ALVERA_STORAGE_REG'),
      ], opts.output);
    });
}
