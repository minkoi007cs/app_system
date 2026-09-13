/** Machine identities and the keys that speak for them. */
import { and, eq } from 'drizzle-orm';
import { InfraError, ipAllowed, normaliseScopes, type ApiKeyScope } from '@infra/core';
import type { MasterDatabase } from '../client.js';
import { infraServiceAccounts, type InfraServiceAccountRow } from '../schema/service-accounts.js';
import { infraApiKeys } from '../schema/api-keys.js';
import { issueApiKey, type IssuedApiKey } from './api-keys.js';

export interface CreateServiceAccountInput {
  appId: string;
  name: string;
  description?: string;
  ownerUserId: string;
  scopes?: ApiKeyScope[];
  ipAllowlist?: string[];
}

export async function createServiceAccount(
  db: MasterDatabase,
  input: CreateServiceAccountInput,
): Promise<InfraServiceAccountRow> {
  const [row] = await db
    .insert(infraServiceAccounts)
    .values({
      appId: input.appId,
      name: input.name,
      description: input.description ?? null,
      ownerUserId: input.ownerUserId,
      scopes: input.scopes ?? ['db:read'],
      ipAllowlist: input.ipAllowlist ?? [],
    })
    .returning();

  if (row === undefined) throw new InfraError('INTERNAL', 'service account insert returned no row');
  return row;
}

export async function listServiceAccounts(
  db: MasterDatabase,
  appId: string,
): Promise<InfraServiceAccountRow[]> {
  return db.select().from(infraServiceAccounts).where(eq(infraServiceAccounts.appId, appId));
}

export async function getServiceAccount(
  db: MasterDatabase,
  id: string,
): Promise<InfraServiceAccountRow | null> {
  const [row] = await db.select().from(infraServiceAccounts).where(eq(infraServiceAccounts.id, id)).limit(1);
  return row ?? null;
}

/** A service-account key is always secret — a machine identity has no business in a browser. */
export async function issueServiceAccountKey(
  db: MasterDatabase,
  serviceAccountId: string,
  createdBy: string,
  name = 'machine key',
): Promise<IssuedApiKey> {
  const account = await getServiceAccount(db, serviceAccountId);
  if (account === null) throw new InfraError('VALIDATION_FAILED', 'service account not found');
  if (account.status !== 'active') throw new InfraError('APP_SUSPENDED', 'service account is not active');

  const issued = await issueApiKey(db, {
    appId: account.appId,
    name: `${account.name} · ${name}`,
    createdBy,
    kind: 'secret',
    scopes: normaliseScopes('secret', account.scopes as ApiKeyScope[]),
  });

  await db
    .update(infraApiKeys)
    .set({ serviceAccountId })
    .where(eq(infraApiKeys.id, issued.row.id));

  return issued;
}

export async function revokeServiceAccount(db: MasterDatabase, id: string): Promise<number> {
  await db.update(infraServiceAccounts).set({ status: 'revoked' }).where(eq(infraServiceAccounts.id, id));

  // Every key that speaks for it dies with it.
  const revoked = await db
    .update(infraApiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(infraApiKeys.serviceAccountId, id)))
    .returning({ id: infraApiKeys.id });

  return revoked.length;
}

export interface ServiceAccountCheck {
  account: InfraServiceAccountRow;
}

/**
 * Extra checks that apply only to machine identities: the account must still be active, and the
 * call must come from an address the owner listed.
 */
export async function assertServiceAccountUsable(
  db: MasterDatabase,
  serviceAccountId: string,
  callerIp: string | null,
): Promise<ServiceAccountCheck> {
  const account = await getServiceAccount(db, serviceAccountId);
  if (account === null) throw new InfraError('API_KEY_INVALID', 'service account not found');
  if (account.status !== 'active') {
    throw new InfraError('API_KEY_REVOKED', 'service account has been revoked');
  }
  if (!ipAllowed(callerIp, account.ipAllowlist)) {
    throw new InfraError('FORBIDDEN_SCOPE', 'this address is not on the service account allowlist', {
      details: { serviceAccountId },
    });
  }

  void db
    .update(infraServiceAccounts)
    .set({ lastUsedAt: new Date() })
    .where(eq(infraServiceAccounts.id, serviceAccountId))
    .catch(() => {});

  return { account };
}
