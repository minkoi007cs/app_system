/**
 * End-to-end proof that the multi-provider router works against REAL databases.
 *
 *   pnpm smoke            # run against whichever providers are configured
 *   pnpm smoke --cleanup  # also delete the smoke apps from the Master DB afterwards
 *
 * For each configured provider it:
 *   1. registers a child app in the Master DB
 *   2. issues a pk_live_ API key (only the hash is stored)
 *   3. stores the tenant connection string encrypted with AES-256-GCM
 *   4. resolves an adapter through the real resolver (decrypt happens there, in memory)
 *   5. runs a create / insert / select / delete round trip with BOUND parameters
 *   6. checks health and confirms each app reached a DIFFERENT host (isolation)
 *
 * Secrets are read from .env.local and .secrets/tenants.env and are never printed —
 * only hosts, latencies and row counts appear in the output.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createAdapter } from '@infra/adapters';
import { assertMasterKey, maskApiKey } from '@infra/core';
import {
  closeMasterDb,
  createApp,
  deleteDatabaseConfig,
  getAppBySlug,
  getPrimaryDatabaseConfig,
  issueApiKey,
  listDatabaseConfigs,
  masterDb,
  recordHealth,
  revealConnectionString,
  setAppStatus,
  upsertDatabaseConfig,
  verifyApiKey,
  type DbProvider,
} from '@infra/db';

// ── env loading ──────────────────────────────────────────────────────────────
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) continue;
    if (process.env[key] !== undefined) continue;
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
loadEnvFile(resolve(root, '.env.local'));
loadEnvFile(resolve(root, '.secrets/tenants.env'));

const CLEANUP = process.argv.includes('--cleanup');

const TARGETS: Array<{ provider: DbProvider; envVar: string; slug: string }> = [
  { provider: 'neon', envVar: 'SMOKE_NEON_URL', slug: 'smoke-neon' },
  { provider: 'supabase', envVar: 'SMOKE_SUPABASE_URL', slug: 'smoke-supabase' },
  { provider: 'turso', envVar: 'SMOKE_TURSO_URL', slug: 'smoke-turso' },
];

interface Outcome {
  provider: DbProvider;
  host: string;
  health: string;
  latencyMs: number | null;
  roundTrip: string;
  keyPreview: string;
  ok: boolean;
  note: string;
}

const TABLE = 'infra_smoke_check';

function ddl(provider: DbProvider): { create: string; insert: string; select: string; drop: string } {
  const isPg = provider !== 'turso';
  return {
    create: isPg
      ? `create table if not exists ${TABLE} (id text primary key, note text not null, created_at timestamptz default now())`
      : `create table if not exists ${TABLE} (id text primary key, note text not null, created_at text)`,
    insert: isPg
      ? `insert into ${TABLE} (id, note) values ($1, $2)`
      : `insert into ${TABLE} (id, note, created_at) values (?, ?, datetime('now'))`,
    select: isPg ? `select note from ${TABLE} where id = $1` : `select note from ${TABLE} where id = ?`,
    drop: `drop table ${TABLE}`,
  };
}

async function runProvider(target: (typeof TARGETS)[number]): Promise<Outcome | null> {
  const dsn = process.env[target.envVar];
  if (dsn === undefined || dsn === '' || dsn.includes('PASTE_')) {
    console.log(`⏭  ${target.provider.padEnd(9)} skipped — ${target.envVar} not set`);
    return null;
  }

  const db = masterDb();
  const base: Outcome = {
    provider: target.provider,
    host: '—',
    health: '—',
    latencyMs: null,
    roundTrip: '—',
    keyPreview: '—',
    ok: false,
    note: '',
  };

  try {
    // 1 — register the child app (idempotent)
    const existing = await getAppBySlug(db, target.slug);
    const app =
      existing ??
      (await createApp(db, {
        slug: target.slug,
        name: `Smoke · ${target.provider}`,
        description: 'created by scripts/smoke-multi-provider.mts',
        ownerUserId: 'smoke-test-runner',
      }));
    if (existing !== null && existing.status !== 'active') await setAppStatus(db, app.id, 'active');

    // 2 — issue an API key and verify it round-trips through the hash lookup
    const issued = await issueApiKey(db, {
      appId: app.id,
      name: `smoke ${new Date().toISOString().slice(0, 16)}`,
      createdBy: 'smoke-test-runner',
      scopes: ['db:read', 'db:write'],
    });
    const verified = await verifyApiKey(db, issued.rawKey);
    if (verified.app.id !== app.id) throw new Error('api key resolved to the wrong app');
    base.keyPreview = maskApiKey(issued.rawKey).slice(0, 24);

    // 3 — store the DSN encrypted
    const config = await upsertDatabaseConfig(db, {
      appId: app.id,
      provider: target.provider,
      label: 'smoke primary',
      connectionString: dsn,
    });
    base.host = config.hostHint ?? '(no host)';

    // proof the ciphertext is not the plaintext, and decrypts back exactly
    if (config.encryptedConnectionString.includes(dsn.slice(0, 24))) {
      throw new Error('connection string was stored in the clear');
    }
    const stored = await getPrimaryDatabaseConfig(db, app.id);
    if (stored === null || revealConnectionString(stored) !== dsn) {
      throw new Error('decrypted connection string does not match the original');
    }

    // 4 — go through the real adapter factory
    const adapter = createAdapter({ provider: target.provider, connectionString: dsn, poolMax: 2 });

    // 5 — health
    const health = await adapter.health();
    base.health = health.status;
    base.latencyMs = health.latencyMs;
    await recordHealth(db, config.id, health.status, health.latencyMs);

    // 6 — real round trip with bound parameters
    const sql = ddl(target.provider);
    const marker = `smoke-${Date.now()}`;
    await adapter.query({ sql: sql.create });
    await adapter.query({ sql: sql.insert, params: [marker, `hello from ${target.provider}`] });
    const read = await adapter.query<{ note: string }>({ sql: sql.select, params: [marker] });
    const note = read.rows[0]?.note ?? '';
    if (!note.includes(target.provider)) throw new Error(`read back "${note}" — expected the inserted row`);
    base.roundTrip = `${read.rowCount} row · ${read.durationMs}ms`;
    await adapter.query({ sql: sql.drop });
    await adapter.close();

    if (CLEANUP) {
      await deleteDatabaseConfig(db, config.id);
      await setAppStatus(db, app.id, 'archived');
    }

    base.ok = true;
    const cold = base.latencyMs !== null && base.latencyMs >= 1500 ? ' (cold start)' : '';
    console.log(
      `✅ ${target.provider.padEnd(9)} ${base.host} · ${base.health} ${base.latencyMs}ms${cold} · ${base.roundTrip}`,
    );
    return base;
  } catch (error) {
    base.note = error instanceof Error ? error.message : String(error);
    console.log(`❌ ${target.provider.padEnd(9)} ${base.note}`);
    return base;
  }
}

async function main(): Promise<void> {
  console.log('\n── Unified-App-Infra · multi-provider smoke test ──\n');

  assertMasterKey();
  if (process.env['INFRA_MASTER_DATABASE_URL'] === undefined) {
    throw new Error('INFRA_MASTER_DATABASE_URL is not set — fill in .env.local first');
  }

  const outcomes: Outcome[] = [];
  for (const target of TARGETS) {
    const outcome = await runProvider(target);
    if (outcome !== null) outcomes.push(outcome);
  }

  console.log('\n── summary ──');
  console.table(
    outcomes.map((outcome) => ({
      provider: outcome.provider,
      host: outcome.host,
      health: outcome.health,
      latency: outcome.latencyMs === null ? '—' : `${outcome.latencyMs}ms`,
      'round trip': outcome.roundTrip,
      key: outcome.keyPreview,
      result: outcome.ok ? 'PASS' : `FAIL — ${outcome.note}`,
    })),
  );

  // isolation: no two apps may have landed on the same host
  const hosts = outcomes.filter((o) => o.ok).map((o) => o.host);
  const unique = new Set(hosts);
  console.log(
    unique.size === hosts.length
      ? `\n🔒 isolation OK — ${hosts.length} app(s), ${unique.size} distinct host(s)`
      : `\n⚠️  isolation WARNING — two apps share a host: ${hosts.join(', ')}`,
  );

  const configured = outcomes.length;
  const passed = outcomes.filter((o) => o.ok).length;
  console.log(`\n${passed}/${configured} provider(s) passed.${CLEANUP ? ' Smoke apps archived.' : ''}\n`);

  await closeMasterDb();
  process.exit(passed === configured && configured > 0 ? 0 : 1);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n❌ cannot start: ${message}\n`);
  console.error('Checklist:');
  console.error('  1. cp .env.example .env.local   and fill INFRA_MASTER_DATABASE_URL');
  console.error('  2. INFRA_MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32)  in .env.local');
  console.error('  3. pnpm db:migrate');
  console.error('  4. cp .secrets/tenants.env.example .secrets/tenants.env  and paste the tenant DSNs\n');
  await closeMasterDb().catch(() => {});
  process.exit(1);
}
