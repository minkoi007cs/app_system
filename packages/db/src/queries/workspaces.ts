/** Workspaces — inert until an app turns on team features. */
import { and, eq } from 'drizzle-orm';
import { InfraError } from '@infra/core';
import type { MasterDatabase } from '../client.js';
import {
  infraWorkspaceMembers,
  infraWorkspaces,
  type InfraWorkspaceRow,
  type WorkspaceRole,
} from '../schema/workspaces.js';

export async function createWorkspace(
  db: MasterDatabase,
  input: { appId: string; slug: string; name: string; createdBy: string },
): Promise<InfraWorkspaceRow> {
  const [row] = await db.insert(infraWorkspaces).values(input).returning();
  if (row === undefined) throw new InfraError('INTERNAL', 'workspace insert returned no row');

  await db
    .insert(infraWorkspaceMembers)
    .values({ workspaceId: row.id, userId: input.createdBy, role: 'owner' });
  return row;
}

export async function listWorkspaces(db: MasterDatabase, appId: string): Promise<InfraWorkspaceRow[]> {
  return db.select().from(infraWorkspaces).where(eq(infraWorkspaces.appId, appId));
}

export async function listWorkspacesForUser(
  db: MasterDatabase,
  appId: string,
  userId: string,
): Promise<Array<{ workspace: InfraWorkspaceRow; role: WorkspaceRole }>> {
  const rows = await db
    .select({ workspace: infraWorkspaces, role: infraWorkspaceMembers.role })
    .from(infraWorkspaceMembers)
    .innerJoin(infraWorkspaces, eq(infraWorkspaceMembers.workspaceId, infraWorkspaces.id))
    .where(and(eq(infraWorkspaceMembers.userId, userId), eq(infraWorkspaces.appId, appId)));
  return rows;
}

export async function addWorkspaceMember(
  db: MasterDatabase,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole = 'member',
): Promise<void> {
  await db
    .insert(infraWorkspaceMembers)
    .values({ workspaceId, userId, role })
    .onConflictDoUpdate({
      target: [infraWorkspaceMembers.workspaceId, infraWorkspaceMembers.userId],
      set: { role },
    });
}

export async function getWorkspaceRole(
  db: MasterDatabase,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: infraWorkspaceMembers.role })
    .from(infraWorkspaceMembers)
    .where(
      and(
        eq(infraWorkspaceMembers.workspaceId, workspaceId),
        eq(infraWorkspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  return row?.role ?? null;
}
