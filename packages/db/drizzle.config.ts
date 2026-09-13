import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

/** drizzle-kit runs outside Next.js, so it has to load the env files itself. */
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

const root = resolve(import.meta.dirname, '../..');
loadEnv(resolve(root, '.env.local'));
loadEnv(resolve(root, '.env'));

// Prefer the project's own variable; fall back to what `neon link` writes.
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
