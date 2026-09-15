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
import { infraApps } from '../schema/apps.js';

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

/**
 * Grants a role. Assigning the same grant twice is a no-op, not a second row.
 *
 * `onConflictDoNothing` rather than a read-then-insert: only the database can actually enforce
 * this (see `infra_ra_unique_grant`). Two concurrent invitations of the same person would both see "not assigned yet" and both
 * insert — the same race the rate-limit counter avoids by never asking first.
 *
 * `expiresAt` is deliberately left alone on conflict. Re-running a setup script must not silently
 * extend somebody's temporary access; changing an expiry is a decision, and it belongs in a call
 * that says so.
 */
export async function assignRole(db: MasterDatabase, input: AssignRoleInput): Promise<void> {
  await db.insert(infraRoleAssignments).values({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    roleId: input.roleId,
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? null,
    expiresAt: input.expiresAt ?? null,
    grantedBy: input.grantedBy,
  // No conflict target: the unique index is on an EXPRESSION (`coalesce(scope_id, '')`), and a
  // plain column list does not match it, so Postgres cannot infer the arbiter and rejects the
  // statement outright — `there is no unique or exclusion constraint matching the ON CONFLICT
  // specification`. A bare `do nothing` covers any unique violation on the table, which here is
  // exactly the one we mean. The only other unique key is the primary key, and that is a fresh
  // uuid on every call.
  }).onConflictDoNothing();
}

export async function revokeRoleAssignment(db: MasterDatabase, assignmentId: string): Promise<void> {
  await db.delete(infraRoleAssignments).where(eq(infraRoleAssignments.id, assignmentId));
}

export interface RoleAssignmentSummary {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  roleKey: string;
  roleName: string;
  permissions: string[];
  scopeType: ScopeType;
  scopeId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/**
 * Every grant that applies to this app, joined to the role it names.
 *
 * Includes grants of platform-wide roles (`infra_roles.app_id is null`) scoped to this app, since
 * those are exactly the ones an admin is most likely to have forgotten about.
 */
export async function listRoleAssignments(
  db: MasterDatabase,
  appId: string,
): Promise<RoleAssignmentSummary[]> {
  return db
    .select({
      id: infraRoleAssignments.id,
      subjectType: infraRoleAssignments.subjectType,
      subjectId: infraRoleAssignments.subjectId,
      roleKey: infraRoles.key,
      roleName: infraRoles.name,
      permissions: infraRoles.permissions,
      scopeType: infraRoleAssignments.scopeType,
      scopeId: infraRoleAssignments.scopeId,
      expiresAt: infraRoleAssignments.expiresAt,
      createdAt: infraRoleAssignments.createdAt,
    })
    .from(infraRoleAssignments)
    .innerJoin(infraRoles, eq(infraRoleAssignments.roleId, infraRoles.id))
    .where(or(eq(infraRoleAssignments.scopeId, appId), eq(infraRoles.appId, appId)));
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

/** A default role may not contain these: they would be handed to every new signup. */
const UNSAFE_FOR_DEFAULT = ['*', '*:*', 'admin', 'admin:*'];

/**
 * Sets (or clears, with `null`) the role granted automatically when somebody joins this app.
 *
 * Refuses a role carrying wildcard or admin permissions. Auto-assignment is a convenience, and a
 * convenience that can hand out `*` is not one — the blast radius of a typo here is every account
 * that ever signs up, including ones created after whoever made the typo has forgotten.
 *
 * This is the part of the design that the reasoning "ABAC protects us anyway" does not cover.
 * ABAC decides **which rows** a person may touch; RBAC decides **which operations** they may
 * perform at all. A default role holding `notes:delete` is fine — they can only delete their own
 * rows. A default role holding `*` is not, because ABAC has nothing to say about a resource that
 * carries no policy: the gateway compiles `1 = 0` and refuses, which protects the data but means
 * the permission was never the thing holding the line. Keep the default role narrow on purpose.
 */
export async function setDefaultRole(
  db: MasterDatabase,
  appId: string,
  roleKey: string | null,
): Promise<void> {
  if (roleKey !== null) {
    const [role] = await db
      .select()
      .from(infraRoles)
      .where(and(eq(infraRoles.appId, appId), eq(infraRoles.key, roleKey)))
      .limit(1);

    if (role === undefined) {
      throw new InfraError('VALIDATION_FAILED', `no role "${roleKey}" on this app`, {
        details: { roleKey },
      });
    }

    const unsafe = role.permissions.filter((permission) =>
      UNSAFE_FOR_DEFAULT.includes(permission.trim().toLowerCase()),
    );
    if (unsafe.length > 0) {
      throw new InfraError(
        'VALIDATION_FAILED',
        `"${roleKey}" carries ${unsafe.join(', ')} and cannot be a default role`,
        { details: { roleKey, unsafe } },
      );
    }
  }

  await db
    .update(infraApps)
    .set({ defaultRoleKey: roleKey, updatedAt: new Date() })
    .where(eq(infraApps.id, appId));
}

/**
 * Grants the app's default role to somebody who just joined. Returns the role key granted, or null.
 *
 * Called on the path where a person becomes a member of an app. Everything about it fails **open**
 * — a missing app, a cleared `default_role_key`, a key naming a role that no longer exists — and
 * that is deliberate in a way worth stating: this grants convenience, not access. Signing in must
 * not break because somebody renamed a role, and the outcome of skipping is that the person has no
 * permissions, which is the safe direction. The authorisation decision itself still fails closed,
 * later, in `checkAccess`.
 *
 * Idempotent through `assignRole`'s unique index, so the ordinary case — a returning member — costs
 * one insert that does nothing.
 */
export async function assignDefaultRole(
  db: MasterDatabase,
  appId: string,
  userId: string,
): Promise<string | null> {
  const [app] = await db
    .select({ defaultRoleKey: infraApps.defaultRoleKey })
    .from(infraApps)
    .where(eq(infraApps.id, appId))
    .limit(1);

  const roleKey = app?.defaultRoleKey ?? null;
  if (roleKey === null || roleKey === '') return null;

  const [role] = await db
    .select({ id: infraRoles.id })
    .from(infraRoles)
    .where(and(eq(infraRoles.appId, appId), eq(infraRoles.key, roleKey)))
    .limit(1);

  // A key naming a role nobody created is a configuration mistake, not a reason to refuse a login.
  if (role === undefined) return null;

  await assignRole(db, {
    subjectType: 'user',
    subjectId: userId,
    roleId: role.id,
    scopeType: 'app',
    scopeId: appId,
    grantedBy: 'default-role',
  });

  return roleKey;
}
