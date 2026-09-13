/** Roles, assignments and policies — the storage half of authorisation. */
import { and, eq, isNull, or } from 'drizzle-orm';
import { InfraError, mergePermissions, SYSTEM_ROLES, type Policy, type PolicyAction } from '@infra/core';
import type { MasterDatabase } from '../client.js';
import {
  infraPolicies,
  infraRoleAssignments,
  infraRoles,
  type InfraPolicyRow,
  type InfraRoleRow,
  type ScopeType,
  type SubjectType,
} from '../schema/access.js';

// ── roles ────────────────────────────────────────────────────────────────────

export async function seedSystemRoles(db: MasterDatabase, appId: string): Promise<InfraRoleRow[]> {
  const created: InfraRoleRow[] = [];
  for (const [key, permissions] of Object.entries(SYSTEM_ROLES)) {
    const [row] = await db
      .insert(infraRoles)
      .values({
        appId,
        key,
        name: key.charAt(0).toUpperCase() + key.slice(1),
        permissions: [...permissions],
        isSystem: true,
      })
      .onConflictDoNothing()
      .returning();
    if (row !== undefined) created.push(row);
  }
  return created;
}

export async function listRoles(db: MasterDatabase, appId: string): Promise<InfraRoleRow[]> {
  return db
    .select()
    .from(infraRoles)
    .where(or(eq(infraRoles.appId, appId), isNull(infraRoles.appId)));
}

export async function createRole(
  db: MasterDatabase,
  input: { appId: string; key: string; name: string; permissions: string[] },
): Promise<InfraRoleRow> {
  const [row] = await db.insert(infraRoles).values({ ...input, isSystem: false }).returning();
  if (row === undefined) throw new InfraError('INTERNAL', 'role insert returned no row');
  return row;
}

// ── assignments ──────────────────────────────────────────────────────────────

export interface AssignRoleInput {
  subjectType: SubjectType;
  subjectId: string;
  roleId: string;
  scopeType: ScopeType;
  scopeId?: string | null;
  expiresAt?: Date | null;
  grantedBy: string;
}

export async function assignRole(db: MasterDatabase, input: AssignRoleInput): Promise<void> {
  await db.insert(infraRoleAssignments).values({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    roleId: input.roleId,
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? null,
    expiresAt: input.expiresAt ?? null,
    grantedBy: input.grantedBy,
  });
}

export async function revokeRoleAssignment(db: MasterDatabase, assignmentId: string): Promise<void> {
  await db.delete(infraRoleAssignments).where(eq(infraRoleAssignments.id, assignmentId));
}

export interface EffectivePermissions {
  roleKeys: string[];
  permissions: string[];
}

/**
 * Every permission a subject holds inside an app: roles assigned at platform scope plus those
 * assigned at this app's scope. Expired grants are dropped here rather than by a cleanup job,
 * so an expiry always takes effect immediately.
 */
export async function effectivePermissions(
  db: MasterDatabase,
  subjectType: SubjectType,
  subjectId: string,
  appId: string,
  now: Date = new Date(),
): Promise<EffectivePermissions> {
  const rows = await db
    .select({ role: infraRoles, assignment: infraRoleAssignments })
    .from(infraRoleAssignments)
    .innerJoin(infraRoles, eq(infraRoleAssignments.roleId, infraRoles.id))
    .where(
      and(
        eq(infraRoleAssignments.subjectType, subjectType),
        eq(infraRoleAssignments.subjectId, subjectId),
        or(
          eq(infraRoleAssignments.scopeType, 'platform'),
          and(eq(infraRoleAssignments.scopeType, 'app'), eq(infraRoleAssignments.scopeId, appId)),
        ),
      ),
    );

  const live = rows.filter(
    (row) => row.assignment.expiresAt === null || row.assignment.expiresAt.getTime() > now.getTime(),
  );

  return {
    roleKeys: live.map((row) => row.role.key),
    permissions: mergePermissions(live.map((row) => row.role.permissions)),
  };
}

// ── policies ─────────────────────────────────────────────────────────────────

export async function listPolicies(
  db: MasterDatabase,
  appId: string,
  resource?: string,
  action?: PolicyAction,
): Promise<Policy[]> {
  const rows = await db.select().from(infraPolicies).where(eq(infraPolicies.appId, appId));

  return rows
    .filter((row) => (resource === undefined ? true : row.resource === resource || row.resource === '*'))
    .filter((row) => (action === undefined ? true : row.action === action))
    .map(toPolicy);
}

export function toPolicy(row: InfraPolicyRow): Policy {
  return {
    id: row.id,
    resource: row.resource,
    action: row.action,
    effect: row.effect,
    condition: row.condition,
    priority: row.priority,
    enabled: row.enabled,
  };
}

export interface CreatePolicyInput {
  appId: string;
  resource: string;
  action: PolicyAction;
  effect: 'allow' | 'deny';
  condition: Policy['condition'];
  priority?: number;
  description?: string;
}

export async function createPolicy(db: MasterDatabase, input: CreatePolicyInput): Promise<InfraPolicyRow> {
  const [row] = await db
    .insert(infraPolicies)
    .values({
      appId: input.appId,
      resource: input.resource,
      action: input.action,
      effect: input.effect,
      condition: input.condition,
      priority: input.priority ?? 100,
      description: input.description ?? null,
    })
    .returning();
  if (row === undefined) throw new InfraError('INTERNAL', 'policy insert returned no row');
  return row;
}

export async function setPolicyEnabled(db: MasterDatabase, policyId: string, enabled: boolean): Promise<void> {
  await db
    .update(infraPolicies)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(infraPolicies.id, policyId));
}

export async function deletePolicy(db: MasterDatabase, policyId: string): Promise<void> {
  await db.delete(infraPolicies).where(eq(infraPolicies.id, policyId));
}
