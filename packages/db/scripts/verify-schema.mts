/** Confirms the migration actually created every table the platform needs. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) continue;
    if (process.env[key] !== undefined && process.env[key] !== '') continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
  }
}

function findRepoRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

const root = findRepoRoot();
loadEnv(resolve(root, '.env.local'));

const { default: postgres } = await import('postgres');

const url =
  process.env['INFRA_MASTER_DATABASE_URL'] ??
  process.env['DATABASE_URL_UNPOOLED'] ??
  process.env['DATABASE_URL'];

if (url === undefined || url === '') {
  console.error('❌ no master database url');
  process.exit(1);
}

const EXPECTED = [
  'infra_apps',
  'infra_api_keys',
  'infra_database_configs',
  'infra_audit_logs',
  'infra_app_members',
  'user',
  'session',
  'account',
  'verification',
];

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15 });
try {
  const rows = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'public'
  `;
  const present = new Set(rows.map((row) => row.table_name));
  let missing = 0;
  for (const table of EXPECTED) {
    const ok = present.has(table);
    if (!ok) missing += 1;
    console.log(`${ok ? '✅' : '❌'} ${table}`);
  }
  console.log(`\n${EXPECTED.length - missing}/${EXPECTED.length} tables present`);
  await sql.end({ timeout: 5 });
  process.exit(missing === 0 ? 0 : 1);
} catch (error) {
  console.error(`❌ could not inspect the database: ${error instanceof Error ? error.message : error}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
