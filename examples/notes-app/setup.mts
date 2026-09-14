/**
 * Registers the example app against a running hub, exactly as a person would in the Dashboard.
 *
 * Idempotent: run it twice and it reuses what exists rather than piling up duplicates. That matters
 * more than it sounds — a setup script that only works on a clean database is a script nobody dares
 * run, and the second run is always the one you do under pressure.
 *
 * Needs the Master DB credentials because it writes the app, keys and policies directly. It never
 * prints a connection string, and it prints each API key exactly once because that is the only
 * moment either of them exists in readable form.
 */
import { createAdapter } from '@infra/adapters';
import { assertMasterKey } from '@infra/core';
import {
  createPolicy,
  createRole,
  getAppBySlug,
  issueApiKey,
  listPolicies,
  listRoles,
  masterDb,
  registerApp,
  revealConnectionString,
  getPrimaryDatabaseConfig,
} from '@infra/db';

const APP_SLUG = process.env.APP_SLUG ?? 'notes-app';
const APP_NAME = process.env.APP_NAME ?? 'Notes';
const TABLE = process.env.APP_TABLE ?? 'notes';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`missing ${name} — see examples/notes-app/README.md`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  required('INFRA_MASTER_DATABASE_URL');
  assertMasterKey();

  const db = masterDb();

  // ── 1. the app ─────────────────────────────────────────────────────────────
  const existing = await getAppBySlug(db, APP_SLUG);
  const app = existing ?? (await registerApp(db, { slug: APP_SLUG, name: APP_NAME, createdBy: 'setup-script' }));
  console.info(`app ${app.slug} → ${app.id}${existing === null ? ' (created)' : ' (existing)'}`);

  // ── 2. keys ────────────────────────────────────────────────────────────────
  const publishable = await issueApiKey(db, {
    appId: app.id,
    name: 'browser',
    createdBy: 'setup-script',
    kind: 'publishable',
    scopes: ['db:read', 'auth:read'],
  });

  const secret = await issueApiKey(db, {
    appId: app.id,
    name: 'server',
    createdBy: 'setup-script',
    kind: 'secret',
    scopes: ['db:read', 'db:write', 'auth:read'],
  });

  // Printed once, here, and never recoverable afterwards — only the SHA-256 is stored.
  console.info('\n  INFRA_PUBLISHABLE_KEY=' + publishable.rawKey);
  console.info('  INFRA_SECRET_KEY=' + secret.rawKey + '\n');

  // ── 3. the table, in the app's own database ────────────────────────────────
  const config = await getPrimaryDatabaseConfig(db, app.id);
  if (config === null) {
    console.error(
      `app ${APP_SLUG} has no database attached yet — add one in the Dashboard, or let Phase 6 ` +
        `provisioning create it, then run this again`,
    );
    process.exit(1);
  }

  const adapter = createAdapter({
    provider: config.provider,
    connectionString: revealConnectionString(config),
  });

  const idType = adapter.dialect === 'postgres' ? 'uuid default gen_random_uuid()' : 'text';
  const timestamp = adapter.dialect === 'postgres' ? 'timestamptz default now()' : "text default (datetime('now'))";

  await adapter.query({
    sql: `create table if not exists ${TABLE} (
      id ${idType} primary key,
      owner_id text not null,
      title text not null,
      body text,
      done boolean default false,
      created_at ${timestamp}
    )`,
  });
  console.info(`table ${TABLE} ready on ${config.provider}`);

  // ── 4. the policies — the step that actually matters ───────────────────────
  const roles = await listRoles(db, app.id);
  const member =
    roles.find((role) => role.key === 'member') ??
    (await createRole(db, {
      appId: app.id,
      key: 'member',
      name: 'Member',
      permissions: [`${TABLE}:read`, `${TABLE}:create`, `${TABLE}:write`, `${TABLE}:delete`],
    }));
  console.info(`role ${member.key} → ${member.permissions.join(' ')}`);

  const wanted = ['select', 'insert', 'update', 'delete'] as const;
  const already = await listPolicies(db, app.id);

  for (const action of wanted) {
    if (already.some((policy) => policy.resource === TABLE && policy.action === action)) {
      console.info(`policy ${TABLE}.${action} already exists`);
      continue;
    }

    await createPolicy(db, {
      appId: app.id,
      resource: TABLE,
      action,
      effect: 'allow',
      // The whole security model of this app, in one line: a row belongs to whoever owns it.
      condition: { op: 'eq', field: 'owner_id', value: { from: 'subject', path: 'id' } },
      description: 'a person sees and edits only their own notes',
    });
    console.info(`policy ${TABLE}.${action} created`);
  }

  await adapter.close();
  console.info('\nready. Put the two keys above into the example env and run `pnpm --filter @infra/example-notes demo`.');
}

main().catch((error: unknown) => {
  // Message only: an error from the driver can quote the DSN it was given.
  console.error('setup failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
