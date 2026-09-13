import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit bundles this file to CJS before running it, so `import.meta.dirname`
 * is undefined here. Walk up from the working directory instead.
 */
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

const root = findRepoRoot();
loadEnv(resolve(root, '.env.local'));
loadEnv(resolve(root, '.env'));

const url =
  process.env['INFRA_MASTER_DATABASE_URL'] ??
  process.env['DATABASE_URL_UNPOOLED'] ??
  process.env['DATABASE_URL'] ??
  '';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
