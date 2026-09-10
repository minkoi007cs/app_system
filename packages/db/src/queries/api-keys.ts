import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  generateApiKey,
  hashApiKey,
  InfraError,
  isApiKeyFormatValid,
  type ApiKeyEnvironment,
  type ApiKeyScope,
} from '@infra/core';
import type { MasterDatabase } from '../client.js';
import { infraApiKeys, type InfraApiKeyRow } from '../schema/api-keys.js';
import { infraApps, type InfraAppRow } from '../schema/apps.js';

export interface IssueApiKeyInput {
  appId: string;
  name: string;
  createdBy: string;
  scopes?: ApiKeyScope[];
  environment?: ApiKeyEnvironment;
  expiresAt?: Date;
}

export interface IssuedApiKey {
  row: InfraApiKeyRow;
  /** Shown to the user exactly once — never stored, never logged. */
  rawKey: string;
}

export async function issueApiKey(db: MasterDatabase, input: IssueApiKeyInput): Promise<IssuedApiKey> {
  const generated = generateApiKey(input.environment ?? 'live');
  const [row] = await db
    .insert(infraApiKeys)
    .values({
      appId: input.appId,
      name: input.name,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      environment: generated.environment,
      scopes: input.scopes ?? ['db:read'],
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();

  if (row === undefined) throw new InfraError('INTERNAL', 'api key insert returned no row');
  return { row, rawKey: generated.raw };
}

export interface VerifiedApiKey {
  key: InfraApiKeyRow;
  app: InfraAppRow;
}

/**
 * Verifies an incoming raw key: format → hash lookup → revoked → expired → app active.
 * The raw key never leaves this function.
 */
export async function verifyApiKey(db: MasterDatabase, rawKey: string, now: Date = new Date()): Promise<VerifiedApiKey> {
  if (!isApiKeyFormatValid(rawKey)) {
    throw new InfraError('API_KEY_MALFORMED', 'API key is not well formed');
  }

  const [found] = await db
    .select({ key: infraApiKeys, app: infraApps })
    .from(infraApiKeys)
    .innerJoin(infraApps, eq(infraApiKeys.appId, infraApps.id))
    .where(eq(infraApiKeys.keyHash, hashApiKey(rawKey)))
    .limit(1);

  if (found === undefined) throw new InfraError('API_KEY_INVALID', 'API key not recognised');
  if (found.key.revokedAt !== null) throw new InfraError('API_KEY_REVOKED', 'API key has been revoked');
  if (found.key.expiresAt !== null && found.key.expiresAt.getTime() <= now.getTime()) {
    throw new InfraError('API_KEY_EXPIRED', 'API key has expired');
  }
  if (found.app.status !== 'active') {
    throw new InfraError('APP_SUSPENDED', `application is ${found.app.status}`, {
      details: { appId: found.app.id },
    });
  }

  return { key: found.key, app: found.app };
}

/** Best-effort usage stamp; callers should not await this on the hot path. */
export async function touchApiKeyUsage(db: MasterDatabase, keyId: string, at: Date = new Date()): Promise<void> {
  await db.update(infraApiKeys).set({ lastUsedAt: at }).where(eq(infraApiKeys.id, keyId));
}

export async function listApiKeys(db: MasterDatabase, appId: string): Promise<InfraApiKeyRow[]> {
  return db
    .select()
    .from(infraApiKeys)
    .where(eq(infraApiKeys.appId, appId))
    .orderBy(desc(infraApiKeys.createdAt));
}

export async function listActiveApiKeys(db: MasterDatabase, appId: string): Promise<InfraApiKeyRow[]> {
  return db
    .select()
    .from(infraApiKeys)
    .where(and(eq(infraApiKeys.appId, appId), isNull(infraApiKeys.revokedAt)))
    .orderBy(desc(infraApiKeys.createdAt));
}

export async function revokeApiKey(
  db: MasterDatabase,
  keyId: string,
  at: Date = new Date(),
): Promise<InfraApiKeyRow | null> {
  const [row] = await db
    .update(infraApiKeys)
    .set({ revokedAt: at })
    .where(and(eq(infraApiKeys.id, keyId), isNull(infraApiKeys.revokedAt)))
    .returning();
  return row ?? null;
}

/** Rotation = issue a replacement, then revoke the old key (history is preserved). */
export async function rotateApiKey(
  db: MasterDatabase,
  keyId: string,
  createdBy: string,
): Promise<IssuedApiKey> {
  const [existing] = await db.select().from(infraApiKeys).where(eq(infraApiKeys.id, keyId)).limit(1);
  if (existing === undefined) throw new InfraError('API_KEY_INVALID', 'API key not found');

  const issued = await issueApiKey(db, {
    appId: existing.appId,
    name: `${existing.name} (rotated)`,
    createdBy,
    scopes: existing.scopes,
    environment: existing.environment,
  });
  await revokeApiKey(db, keyId);
  return issued;
}
