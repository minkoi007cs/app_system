/** user ↔ app membership: the enforcement point for cross-app isolation. */
import { and, eq } from 'drizzle-orm';
import { InfraError } from '@infra/core';
import type { MasterDatabase } from '../client.js';
import { infraAppMembers, user, type AppMemberRole } from '../schema/auth.js';
import { infraApps } from '../schema/apps.js';

export interface Membership {
  appId: string;
  userId: string;
  role: AppMemberRole;
  joinedAt: Date;
}

export async function addMember(
  db: MasterDatabase,
  appId: string,
  userId: string,
  role: AppMemberRole = 'member',
): Promise<Membership> {
  const [row] = await db
    .insert(infraAppMembers)
    .values({ appId, userId, role })
    .onConflictDoUpdate({ target: [infraAppMembers.appId, infraAppMembers.userId], set: { role } })
    .returning();

  if (row === undefined) throw new InfraError('INTERNAL', 'membership insert returned no row');
  return row;
}

export async function removeMember(db: MasterDatabase, appId: string, userId: string): Promise<void> {
  await db
    .delete(infraAppMembers)
    .where(and(eq(infraAppMembers.appId, appId), eq(infraAppMembers.userId, userId)));
}

export async function getMembership(
  db: MasterDatabase,
  appId: string,
  userId: string,
): Promise<Membership | null> {
  const [row] = await db
    .select()
    .from(infraAppMembers)
    .where(and(eq(infraAppMembers.appId, appId), eq(infraAppMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Throws instead of returning null — use this on any path that reads app data. */
export async function requireMembership(
  db: MasterDatabase,
  appId: string,
  userId: string,
): Promise<Membership> {
  const membership = await getMembership(db, appId, userId);
  if (membership === null) {
    throw new InfraError('FORBIDDEN_SCOPE', 'user is not a member of this application', {
      details: { appId },
    });
  }
  return membership;
}

export interface AppMemberSummary {
  userId: string;
  email: string;
  name: string;
  role: AppMemberRole;
  joinedAt: Date;
}

/** Members of ONE app only — this is what stops app A from seeing app B's users. */
export async function listMembersOfApp(db: MasterDatabase, appId: string): Promise<AppMemberSummary[]> {
  return db
    .select({
      userId: infraAppMembers.userId,
      email: user.email,
      name: user.name,
      role: infraAppMembers.role,
      joinedAt: infraAppMembers.joinedAt,
    })
    .from(infraAppMembers)
    .innerJoin(user, eq(infraAppMembers.userId, user.id))
    .where(eq(infraAppMembers.appId, appId));
}

export async function listAppsForUser(
  db: MasterDatabase,
  userId: string,
): Promise<Array<{ appId: string; slug: string; name: string; role: AppMemberRole }>> {
  return db
    .select({
      appId: infraApps.id,
      slug: infraApps.slug,
      name: infraApps.name,
      role: infraAppMembers.role,
    })
    .from(infraAppMembers)
    .innerJoin(infraApps, eq(infraAppMembers.appId, infraApps.id))
    .where(eq(infraAppMembers.userId, userId));
}
