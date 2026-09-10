import { and, desc, eq } from 'drizzle-orm';
import { InfraError } from '@infra/core';
import type { MasterDatabase } from '../client.js';
import { infraApps, type AppStatus, type InfraAppRow, type NewInfraApp } from '../schema/apps.js';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function assertValidSlug(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new InfraError(
      'VALIDATION_FAILED',
      'app slug must be lowercase letters, digits and hyphens (2-63 characters)',
      { details: { slug } },
    );
  }
  return slug;
}

export async function createApp(db: MasterDatabase, input: NewInfraApp): Promise<InfraAppRow> {
  assertValidSlug(input.slug);
  const [row] = await db.insert(infraApps).values(input).returning();
  if (row === undefined) throw new InfraError('INTERNAL', 'app insert returned no row');
  return row;
}

export async function getAppById(db: MasterDatabase, appId: string): Promise<InfraAppRow | null> {
  const [row] = await db.select().from(infraApps).where(eq(infraApps.id, appId)).limit(1);
  return row ?? null;
}

export async function getAppBySlug(db: MasterDatabase, slug: string): Promise<InfraAppRow | null> {
  const [row] = await db.select().from(infraApps).where(eq(infraApps.slug, slug)).limit(1);
  return row ?? null;
}

export async function requireActiveApp(db: MasterDatabase, appId: string): Promise<InfraAppRow> {
  const app = await getAppById(db, appId);
  if (app === null) throw new InfraError('APP_NOT_FOUND', 'application not found', { details: { appId } });
  if (app.status !== 'active') {
    throw new InfraError('APP_SUSPENDED', `application is ${app.status}`, { details: { appId } });
  }
  return app;
}

export async function listAppsForOwner(db: MasterDatabase, ownerUserId: string): Promise<InfraAppRow[]> {
  return db
    .select()
    .from(infraApps)
    .where(eq(infraApps.ownerUserId, ownerUserId))
    .orderBy(desc(infraApps.createdAt));
}

export async function setAppStatus(
  db: MasterDatabase,
  appId: string,
  status: AppStatus,
): Promise<InfraAppRow | null> {
  const [row] = await db
    .update(infraApps)
    .set({
      status,
      updatedAt: new Date(),
      archivedAt: status === 'archived' ? new Date() : null,
    })
    .where(eq(infraApps.id, appId))
    .returning();
  return row ?? null;
}

export async function updateAllowedOrigins(
  db: MasterDatabase,
  appId: string,
  origins: string[],
): Promise<InfraAppRow | null> {
  const [row] = await db
    .update(infraApps)
    .set({ allowedOrigins: origins, updatedAt: new Date() })
    .where(eq(infraApps.id, appId))
    .returning();
  return row ?? null;
}

/** Every origin the auth hub should trust, across all active apps. */
export async function loadAllTrustedOrigins(db: MasterDatabase): Promise<string[]> {
  const rows = await db
    .select({ allowedOrigins: infraApps.allowedOrigins })
    .from(infraApps)
    .where(and(eq(infraApps.status, 'active')));
  return [...new Set(rows.flatMap((row) => row.allowedOrigins))];
}
