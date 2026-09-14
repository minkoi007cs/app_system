/**
 * Bookkeeping for resources created at a provider.
 *
 * The ordering rule everywhere in this file: **record before you create, and never delete the
 * record until the remote resource is confirmed gone.** A crash between the two must leave a row
 * that says "this may exist at Neon" rather than nothing at all — an orphan you know about costs a
 * reclaim pass, an orphan you do not know about costs a free-tier slot permanently.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { InfraError } from '@infra/core';
import type { MasterDatabase } from '../client.js';
import type { DbProvider } from '../schema/database-configs.js';
import {
  infraProviderQuotas,
  infraProvisionedResources,
  type InfraProviderQuotaRow,
  type InfraProvisionedResourceRow,
} from '../schema/provisioning.js';

export interface RecordResourceInput {
  appId: string;
  provider: DbProvider;
  externalId: string;
  region?: string | null;
}

export async function recordProvisionedResource(
  db: MasterDatabase,
  input: RecordResourceInput,
): Promise<InfraProvisionedResourceRow> {
  const [row] = await db
    .insert(infraProvisionedResources)
    .values({
      appId: input.appId,
      provider: input.provider,
      externalId: input.externalId,
      region: input.region ?? null,
    })
    .returning();

  if (row === undefined) throw new InfraError('INTERNAL', 'provisioned resource insert returned no row');
  return row;
}

export async function listProvisionedResources(
  db: MasterDatabase,
  appId: string,
): Promise<InfraProvisionedResourceRow[]> {
  return db.select().from(infraProvisionedResources).where(eq(infraProvisionedResources.appId, appId));
}

/** Marks the intent to release. The remote call happens after this, never before. */
export async function markReleasing(db: MasterDatabase, resourceId: string): Promise<void> {
  await db
    .update(infraProvisionedResources)
    .set({ state: 'releasing', releaseAttempts: sql`${infraProvisionedResources.releaseAttempts} + 1` })
    .where(eq(infraProvisionedResources.id, resourceId));
}

export async function markReleased(db: MasterDatabase, resourceId: string): Promise<void> {
  await db
    .update(infraProvisionedResources)
    .set({ state: 'released', releasedAt: new Date(), lastError: null })
    .where(eq(infraProvisionedResources.id, resourceId));
}

/**
 * A release that failed. After enough attempts the row is flagged `orphaned` — not deleted, because
 * a human needs to see that something is still sitting at the provider.
 */
export const ORPHAN_AFTER_ATTEMPTS = 5;

export async function markReleaseFailed(
  db: MasterDatabase,
  resource: InfraProvisionedResourceRow,
  reason: string,
): Promise<void> {
  const attempts = resource.releaseAttempts + 1;
  await db
    .update(infraProvisionedResources)
    .set({
      state: attempts >= ORPHAN_AFTER_ATTEMPTS ? 'orphaned' : 'active',
      lastError: reason.slice(0, 255),
      releaseAttempts: attempts,
    })
    .where(eq(infraProvisionedResources.id, resource.id));
}

/** Everything still standing at a provider that no longer has an app, plus retries in progress. */
export async function listReclaimable(db: MasterDatabase): Promise<InfraProvisionedResourceRow[]> {
  return db
    .select()
    .from(infraProvisionedResources)
    .where(
      and(
        inArray(infraProvisionedResources.state, ['active', 'releasing']),
        sql`${infraProvisionedResources.appId} is null`,
      ),
    );
}

// ── quotas ───────────────────────────────────────────────────────────────────

export interface QuotaReading {
  provider: DbProvider;
  used: number;
  limit: number | null;
  error?: string | null;
}

export async function recordQuota(db: MasterDatabase, reading: QuotaReading): Promise<void> {
  const now = new Date();
  await db
    .insert(infraProviderQuotas)
    .values({
      provider: reading.provider,
      used: reading.used,
      quotaLimit: reading.limit,
      lastError: reading.error ?? null,
      checkedAt: now,
    })
    .onConflictDoUpdate({
      target: infraProviderQuotas.provider,
      set: { used: reading.used, quotaLimit: reading.limit, lastError: reading.error ?? null, checkedAt: now },
    });
}

export async function listQuotas(db: MasterDatabase): Promise<InfraProviderQuotaRow[]> {
  return db.select().from(infraProviderQuotas);
}

export interface QuotaVerdict {
  allowed: boolean;
  used: number;
  limit: number | null;
  reason?: string;
}

/**
 * Checked before provisioning, from our own last reading.
 *
 * Deliberately **fails open** on a missing or stale reading: refusing to create an app because a
 * quota poll has not run yet would make an unrelated background job load-bearing for app creation.
 * The provider itself refuses over-quota requests anyway — this check exists to give a clear
 * message before spending a round trip, not to be the only thing standing between us and the limit.
 */
export function checkQuota(row: InfraProviderQuotaRow | undefined, headroom = 0): QuotaVerdict {
  if (row === undefined) return { allowed: true, used: 0, limit: null, reason: 'no reading yet' };
  if (row.quotaLimit === null) return { allowed: true, used: row.used, limit: null };

  const allowed = row.used + headroom < row.quotaLimit;
  return {
    allowed,
    used: row.used,
    limit: row.quotaLimit,
    ...(allowed ? {} : { reason: `free tier limit reached (${row.used}/${row.quotaLimit})` }),
  };
}

export async function quotaFor(db: MasterDatabase, provider: DbProvider): Promise<QuotaVerdict> {
  const [row] = await db
    .select()
    .from(infraProviderQuotas)
    .where(eq(infraProviderQuotas.provider, provider))
    .limit(1);
  return checkQuota(row);
}

/**
 * Polls every configured provider and stores the reading.
 *
 * A provider that errors is recorded with its previous `used` count and a `lastError`, never with
 * zero: a failed poll that writes 0 would read as "plenty of room" and is exactly the wrong way
 * for this to fail.
 */
export async function collectUsageInto(
  db: MasterDatabase,
  readings: readonly QuotaReading[],
): Promise<number> {
  for (const reading of readings) {
    if (reading.used < 0) {
      await db
        .update(infraProviderQuotas)
        .set({ lastError: reading.error ?? 'usage poll failed', checkedAt: new Date() })
        .where(eq(infraProviderQuotas.provider, reading.provider));
      continue;
    }
    await recordQuota(db, reading);
  }
  return readings.length;
}
