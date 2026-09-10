import { and, desc, eq } from 'drizzle-orm';
import { buildAad, decryptSecret, encryptSecret, InfraError, type EncryptedPayload } from '@infra/core';
import type { MasterDatabase } from '../client.js';
import {
  infraDatabaseConfigs,
  type DbProvider,
  type HealthStatus,
  type InfraDatabaseConfigRow,
  type SqlDialect,
} from '../schema/database-configs.js';

const DIALECT_BY_PROVIDER: Readonly<Record<DbProvider, SqlDialect>> = {
  neon: 'postgres',
  supabase: 'postgres',
  turso: 'libsql',
};

export function dialectForProvider(provider: DbProvider): SqlDialect {
  return DIALECT_BY_PROVIDER[provider];
}

/** Host portion of a DSN, for display only. Never returns credentials. */
export function hostHintOf(connectionString: string): string | null {
  try {
    const url = new URL(connectionString);
    return url.host === '' ? null : url.host;
  } catch {
    return null;
  }
}

export interface UpsertDatabaseConfigInput {
  appId: string;
  provider: DbProvider;
  label: string;
  connectionString: string;
  poolMax?: number;
  isPrimary?: boolean;
}

/**
 * Encrypts the connection string and stores only the envelope.
 * The plaintext is never written to the row, the log or the return value.
 */
export async function upsertDatabaseConfig(
  db: MasterDatabase,
  input: UpsertDatabaseConfigInput,
): Promise<InfraDatabaseConfigRow> {
  const isPrimary = input.isPrimary ?? true;
  const configId = crypto.randomUUID();
  const sealed = encryptSecret(input.connectionString, buildAad(input.appId, configId));

  if (isPrimary) {
    await db
      .update(infraDatabaseConfigs)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(and(eq(infraDatabaseConfigs.appId, input.appId), eq(infraDatabaseConfigs.isPrimary, true)));
  }

  const [row] = await db
    .insert(infraDatabaseConfigs)
    .values({
      id: configId,
      appId: input.appId,
      provider: input.provider,
      dialect: dialectForProvider(input.provider),
      label: input.label,
      isPrimary,
      encryptedConnectionString: sealed.ciphertext,
      encryptionIv: sealed.iv,
      encryptionAuthTag: sealed.authTag,
      encryptionKeyVersion: sealed.keyVersion,
      hostHint: hostHintOf(input.connectionString),
      poolMax: input.poolMax ?? 3,
    })
    .returning();

  if (row === undefined) throw new InfraError('INTERNAL', 'database config insert returned no row');
  return row;
}

export async function listDatabaseConfigs(
  db: MasterDatabase,
  appId: string,
): Promise<InfraDatabaseConfigRow[]> {
  return db
    .select()
    .from(infraDatabaseConfigs)
    .where(eq(infraDatabaseConfigs.appId, appId))
    .orderBy(desc(infraDatabaseConfigs.isPrimary), desc(infraDatabaseConfigs.createdAt));
}

export async function getPrimaryDatabaseConfig(
  db: MasterDatabase,
  appId: string,
): Promise<InfraDatabaseConfigRow | null> {
  const [row] = await db
    .select()
    .from(infraDatabaseConfigs)
    .where(and(eq(infraDatabaseConfigs.appId, appId), eq(infraDatabaseConfigs.isPrimary, true)))
    .limit(1);
  return row ?? null;
}

export function envelopeOf(row: InfraDatabaseConfigRow): EncryptedPayload {
  return {
    ciphertext: row.encryptedConnectionString,
    iv: row.encryptionIv,
    authTag: row.encryptionAuthTag,
    keyVersion: row.encryptionKeyVersion,
  };
}

/**
 * Decrypts a stored connection string.
 * Callers must keep the result in memory only — never log, serialise or return it to a client.
 */
export function revealConnectionString(row: InfraDatabaseConfigRow): string {
  return decryptSecret(envelopeOf(row), buildAad(row.appId, row.id));
}

export async function requirePrimaryConnection(
  db: MasterDatabase,
  appId: string,
): Promise<{ row: InfraDatabaseConfigRow; connectionString: string }> {
  const row = await getPrimaryDatabaseConfig(db, appId);
  if (row === null) {
    throw new InfraError('DB_CONFIG_MISSING', 'no primary database configured for this app', {
      details: { appId },
    });
  }
  return { row, connectionString: revealConnectionString(row) };
}

export async function recordHealth(
  db: MasterDatabase,
  configId: string,
  status: HealthStatus,
  latencyMs: number | null,
  at: Date = new Date(),
): Promise<void> {
  await db
    .update(infraDatabaseConfigs)
    .set({ healthStatus: status, healthLatencyMs: latencyMs, healthCheckedAt: at, updatedAt: at })
    .where(eq(infraDatabaseConfigs.id, configId));
}

export async function deleteDatabaseConfig(db: MasterDatabase, configId: string): Promise<void> {
  await db.delete(infraDatabaseConfigs).where(eq(infraDatabaseConfigs.id, configId));
}
