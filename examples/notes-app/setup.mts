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
 *
 * ── 2026-09-15 ──────────────────────────────────────────────────────────────
 * This file had never run before today. It imported `registerApp`, which does not exist in
 * `@infra/db` — the import alone would have thrown. It also passed `createdBy` to `createApp`,
 * whose row requires `ownerUserId`. Two errors, neither reachable by any test, in the script that
 * backs this repo's headline claim. The lesson the rest of the project keeps relearning applies
 * here too: a path nobody has executed is not a working path, however carefully it reads.
 */
import { createAdapter } from '@infra/adapters';
import { addMember, auth } from '@infra/auth';
import { assertMasterKey } from '@infra/core';
import {
  assignRole,
  createApp,
  createPolicy,
  createRole,
  getAppBySlug,
  getPrimaryDatabaseConfig,
  issueApiKey,
  listPolicies,
  listRoles,
  findUserByEmail,
  masterDb,
  revealConnectionString,
  upsertDatabaseConfig,
} from '@infra/db';

const APP_SLUG = process.env.APP_SLUG ?? 'notes-app';
const APP_NAME = process.env.APP_NAME ?? 'Notes';
const TABLE = process.env.APP_TABLE ?? 'notes';

/**
 * Where this app's database comes from. Either of:
 *
 *   REUSE_DB_FROM=<slug>       share the database already attached to another app
 *   NOTES_DATABASE_URL=<dsn>   attach a tenant database directly (never printed)
 *
 * Neither is needed once a database is attached — the next run finds it and moves on.
 * Auto-provisioning (Phase 6) is a third way and needs NEON_API_KEY; this script does not use it.
 */
const REUSE_DB_FROM = process.env.REUSE_DB_FROM ?? '';

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
  // `ownerUserId` is not optional on the row. The example has no human owner, so it carries a
  // marker id that is obviously not a person — better than inventing a fake user row that later
  // turns up in a user list nobody can explain.
  const existing = await getAppBySlug(db, APP_SLUG);
  const app =
    existing ??
    (await createApp(db, {
      slug: APP_SLUG,
      name: APP_NAME,
      ownerUserId: process.env.APP_OWNER_ID ?? 'example-setup-script',
    }));
  console.info(`app ${app.slug} → ${app.id}${existing === null ? ' (created)' : ' (existing)'}`);

  // ── 2. keys ────────────────────────────────────────────────────────────────
  const publishable = await issueApiKey(db, {
    appId: app.id,
    name: 'browser',
    createdBy: app.ownerUserId,
    kind: 'publishable',
    scopes: ['db:read', 'auth:read'],
  });

  const secret = await issueApiKey(db, {
    appId: app.id,
    name: 'server',
    createdBy: app.ownerUserId,
    kind: 'secret',
    scopes: ['db:read', 'db:write', 'auth:read'],
  });

  // Printed once, here, and never recoverable afterwards — only the SHA-256 is stored.
  console.info('\n  INFRA_PUBLISHABLE_KEY=' + publishable.rawKey);
  console.info('  INFRA_SECRET_KEY=' + secret.rawKey + '\n');

  // ── 3. the table, in the app's own database ────────────────────────────────
  let config = await getPrimaryDatabaseConfig(db, app.id);

  if (config === null && REUSE_DB_FROM !== '') {
    // Share another app's database. The ciphertext cannot simply be copied across: the AAD binds
    // it to its own (appId, configId), so it is decrypted here and re-encrypted under this row.
    const donorApp = await getAppBySlug(db, REUSE_DB_FROM);
    const donor = donorApp === null ? null : await getPrimaryDatabaseConfig(db, donorApp.id);
    if (donor === null) {
      console.error(`REUSE_DB_FROM=${REUSE_DB_FROM} has no database attached`);
      process.exit(1);
    }
    config = await upsertDatabaseConfig(db, {
      appId: app.id,
      provider: donor.provider,
      label: `shared with ${REUSE_DB_FROM}`,
      connectionString: revealConnectionString(donor),
    });
    console.info(`database attached, shared with ${REUSE_DB_FROM} (${donor.provider})`);
  } else if (config === null && (process.env.NOTES_DATABASE_URL ?? '') !== '') {
    config = await upsertDatabaseConfig(db, {
      appId: app.id,
      provider: (process.env.NOTES_DB_PROVIDER ?? 'neon') as 'neon' | 'supabase' | 'turso',
      label: 'notes',
      connectionString: required('NOTES_DATABASE_URL'),
    });
    console.info('database attached from NOTES_DATABASE_URL');
  }

  if (config === null) {
    console.error(
      `app ${APP_SLUG} has no database attached yet. Give it one of:\n` +
        `  REUSE_DB_FROM=<slug>        share the database of an app that already has one\n` +
        `  NOTES_DATABASE_URL=<dsn>    attach a tenant database directly\n` +
        `or attach one in the Dashboard, then run this again.`,
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

  // ── 5. two demo people, with the role actually attached ───────────────────
  //
  // This step exists because of something only a real run revealed: signing in makes a person a
  // member of the app (`infra_app_members`), but RBAC reads permissions from
  // `infra_role_assignments`. Creating the `member` role above attaches it to nobody. So a person
  // could sign in, hold a valid token, and still be told `role does not grant notes:create` —
  // which is correct behaviour, and completely opaque from the outside.
  //
  // An admin doing this in the Dashboard would tick a box. Here the setup script does it, because
  // "the example works after you also do an undocumented step" is not an example that works.
  const people = [
    { email: process.env.USER_A ?? 'alice@example.com', password: process.env.PASS_A ?? 'correct-horse-battery-7' },
    { email: process.env.USER_B ?? 'bob@example.com', password: process.env.PASS_B ?? 'correct-horse-battery-9' },
  ];

  for (const person of people) {
    let user = await findUserByEmail(db, person.email);

    if (user === null) {
      // The same sign-up the hub exposes over HTTP, called directly — no server needed to seed.
      await auth().api.signUpEmail({
        body: { email: person.email, password: person.password, name: person.email.split('@')[0] ?? 'demo' },
      });
      user = await findUserByEmail(db, person.email);
    }

    if (user === null) {
      console.error(`could not create the demo account for ${person.email.slice(0, 2)}***`);
      process.exit(1);
    }

    await addMember(db, app.id, user.id, 'member');
    await assignRole(db, {
      subjectType: 'user',
      subjectId: user.id,
      roleId: member.id,
      scopeType: 'app',
      scopeId: app.id,
      grantedBy: app.ownerUserId,
    });
    console.info(`person ${person.email.slice(0, 2)}*** → role ${member.key} on ${app.slug}`);
  }

  await adapter.close();
  console.info('\nready. Put the two keys above into the example env and run `pnpm --filter @infra/example-notes demo`.');
}

main().catch((error: unknown) => {
  // Message only: an error from the driver can quote the DSN it was given.
  console.error('setup failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
