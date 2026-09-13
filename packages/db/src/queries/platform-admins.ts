/** Platform admin roster — one of the three conditions guarding the control plane. */
import { eq } from 'drizzle-orm';
import { InfraError } from '@infra/core';
import type { MasterDatabase } from '../client.js';
import {
  infraPlatformAdmins,
  type InfraPlatformAdminRow,
  type PlatformAdminRole,
} from '../schema/platform-admins.js';
import { user } from '../schema/auth.js';

export async function getPlatformAdmin(
  db: MasterDatabase,
  userId: string,
): Promise<InfraPlatformAdminRow | null> {
  const [row] = await db
    .select()
    .from(infraPlatformAdmins)
    .where(eq(infraPlatformAdmins.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Creates the admin row for an allowlisted email on first sign-in — this is how the very first
 * administrator comes into existence without a seed script. The caller MUST have checked the
 * allowlist already; this function does not know about it on purpose.
 */
export async function ensurePlatformAdmin(
  db: MasterDatabase,
  userId: string,
  role: PlatformAdminRole = 'super_admin',
): Promise<InfraPlatformAdminRow> {
  const existing = await getPlatformAdmin(db, userId);
  if (existing !== null) return existing;

  const [row] = await db.insert(infraPlatformAdmins).values({ userId, role }).returning();
  if (row === undefined) throw new InfraError('INTERNAL', 'platform admin insert returned no row');
  return row;
}

export async function revokePlatformAdmin(db: MasterDatabase, userId: string): Promise<void> {
  await db
    .update(infraPlatformAdmins)
    .set({ status: 'revoked' })
    .where(eq(infraPlatformAdmins.userId, userId));
}

export interface PlatformAdminSummary {
  userId: string;
  email: string;
  name: string;
  role: PlatformAdminRole;
  status: string;
  lastSeenAt: Date | null;
}

export async function listPlatformAdmins(db: MasterDatabase): Promise<PlatformAdminSummary[]> {
  return db
    .select({
      userId: infraPlatformAdmins.userId,
      email: user.email,
      name: user.name,
      role: infraPlatformAdmins.role,
      status: infraPlatformAdmins.status,
      lastSeenAt: infraPlatformAdmins.lastSeenAt,
    })
    .from(infraPlatformAdmins)
    .innerJoin(user, eq(infraPlatformAdmins.userId, user.id));
}

export async function touchPlatformAdmin(db: MasterDatabase, userId: string): Promise<void> {
  await db
    .update(infraPlatformAdmins)
    .set({ lastSeenAt: new Date() })
    .where(eq(infraPlatformAdmins.userId, userId));
}
