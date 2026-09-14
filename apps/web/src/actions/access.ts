'use server';

import { revalidatePath } from 'next/cache';
import {
  IDENTIFIER_PATTERN,
  InfraError,
  parsePermission,
  type PolicyAction,
  type PolicyCondition,
} from '@infra/core';
import {
  assignRole,
  createPolicy,
  createRole,
  deletePolicy,
  listRoles,
  recordAudit,
  revokeRoleAssignment,
  setPolicyEnabled,
} from '@infra/db';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/admin';

export interface AccessState {
  ok: boolean;
  message: string;
}

function ok(message: string): AccessState {
  return { ok: true, message };
}

function failed(error: unknown, fallback: string): AccessState {
  return { ok: false, message: InfraError.is(error) ? error.message : fallback };
}

// ── roles ────────────────────────────────────────────────────────────────────

export async function createRoleAction(_prev: AccessState, formData: FormData): Promise<AccessState> {
  try {
    const admin = await requireSuperAdmin();
    const appId = String(formData.get('appId') ?? '');
    const key = String(formData.get('key') ?? '').trim().toLowerCase();
    const name = String(formData.get('name') ?? '').trim();
    const permissions = String(formData.get('permissions') ?? '')
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter((value) => value !== '');

    if (!/^[a-z][a-z0-9_-]{1,47}$/.test(key)) {
      throw new InfraError('VALIDATION_FAILED', 'role key must be lower-case letters, digits, - or _');
    }
    if (permissions.length === 0) {
      throw new InfraError('VALIDATION_FAILED', 'a role with no permissions grants nothing');
    }

    // Parsed rather than pattern-matched, so a malformed permission is refused here and never
    // reaches a `hasPermission` call where it would silently match nothing.
    for (const permission of permissions) parsePermission(permission);

    const role = await createRole(db(), { appId, key, name: name === '' ? key : name, permissions });

    await recordAudit(db(), {
      appId,
      actorType: 'admin',
      actorId: admin.userId,
      action: 'role.assigned',
      targetType: 'role',
      targetId: role.id,
      meta: { key, permissions },
    });

    revalidatePath(`/apps/${appId}/access`);
    return ok(`role "${key}" created`);
  } catch (error) {
    return failed(error, 'could not create that role');
  }
}

export async function assignRoleAction(_prev: AccessState, formData: FormData): Promise<AccessState> {
  try {
    const admin = await requireSuperAdmin();
    const appId = String(formData.get('appId') ?? '');
    const subjectId = String(formData.get('subjectId') ?? '').trim();
    const roleId = String(formData.get('roleId') ?? '');
    const subjectType = formData.get('subjectType') === 'service_account' ? 'service_account' : 'user';
    const expiresInDays = Number(formData.get('expiresInDays') ?? 0);

    if (subjectId === '') throw new InfraError('VALIDATION_FAILED', 'subject id is required');
    if (roleId === '') throw new InfraError('VALIDATION_FAILED', 'pick a role');

    const roles = await listRoles(db(), appId);
    const role = roles.find((candidate) => candidate.id === roleId);
    if (role === undefined) throw new InfraError('VALIDATION_FAILED', 'that role does not exist here');

    await assignRole(db(), {
      subjectType,
      subjectId,
      roleId,
      scopeType: 'app',
      scopeId: appId,
      // A grant that expires on its own is the safest kind; the form offers it by default.
      expiresAt: expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
      grantedBy: admin.userId,
    });

    await recordAudit(db(), {
      appId,
      actorType: 'admin',
      actorId: admin.userId,
      action: 'role.assigned',
      targetType: subjectType,
      targetId: subjectId,
      meta: { roleKey: role.key, expiresInDays: expiresInDays > 0 ? expiresInDays : null },
    });

    revalidatePath(`/apps/${appId}/access`);
    return ok(`${role.key} granted to ${subjectId}`);
  } catch (error) {
    return failed(error, 'could not grant that role');
  }
}

export async function revokeAssignmentAction(appId: string, assignmentId: string): Promise<AccessState> {
  try {
    const admin = await requireSuperAdmin();
    await revokeRoleAssignment(db(), assignmentId);

    await recordAudit(db(), {
      appId,
      actorType: 'admin',
      actorId: admin.userId,
      action: 'role.revoked',
      targetType: 'role_assignment',
      targetId: assignmentId,
    });

    revalidatePath(`/apps/${appId}/access`);
    return ok('grant revoked');
  } catch (error) {
    return failed(error, 'could not revoke that grant');
  }
}

// ── policies ─────────────────────────────────────────────────────────────────

const POLICY_ACTIONS: readonly PolicyAction[] = ['select', 'insert', 'update', 'delete'];
const CLAUSE_OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_not_null'] as const;
const SUBJECT_PATHS = ['id', 'app_id', 'workspace_id', 'roles'] as const;

/**
 * Builds the condition from the form.
 *
 * The form offers a deliberately small vocabulary — up to three clauses ANDed together — rather
 * than a free tree editor. The shapes people actually write ("rows I own", "rows in my workspace",
 * "rows not soft-deleted") all fit, and a UI that can express everything is a UI in which nobody
 * can tell at a glance what a policy does.
 */
function buildCondition(formData: FormData): PolicyCondition {
  const shape = String(formData.get('conditionShape') ?? 'clauses');
  if (shape === 'always') return { op: 'always' };
  if (shape === 'never') return { op: 'never' };

  const clauses: PolicyCondition[] = [];

  for (let index = 0; index < 3; index += 1) {
    const field = String(formData.get(`clause${index}Field`) ?? '').trim().toLowerCase();
    if (field === '') continue;
    if (!IDENTIFIER_PATTERN.test(field)) {
      throw new InfraError('VALIDATION_FAILED', `"${field}" is not a valid column name`);
    }

    const rawOp = String(formData.get(`clause${index}Op`) ?? 'eq');
    if (!(CLAUSE_OPS as readonly string[]).includes(rawOp)) {
      throw new InfraError('VALIDATION_FAILED', 'unknown comparison');
    }
    const op = rawOp as (typeof CLAUSE_OPS)[number];

    if (op === 'is_null' || op === 'is_not_null') {
      clauses.push({ op, field });
      continue;
    }

    const source = String(formData.get(`clause${index}Source`) ?? 'subject');
    const rawValue = String(formData.get(`clause${index}Value`) ?? '').trim();

    if (source === 'subject') {
      if (!(SUBJECT_PATHS as readonly string[]).includes(rawValue)) {
        throw new InfraError('VALIDATION_FAILED', `unknown subject attribute "${rawValue}"`);
      }
      clauses.push({ op, field, value: { from: 'subject', path: rawValue as 'id' } });
    } else {
      const literal = rawValue === 'true' ? true : rawValue === 'false' ? false : rawValue;
      clauses.push({ op, field, value: { from: 'literal', value: literal } });
    }
  }

  if (clauses.length === 0) {
    throw new InfraError(
      'VALIDATION_FAILED',
      'add at least one clause, or choose "always"/"never" explicitly',
    );
  }
  if (clauses.length === 1) return clauses[0] as PolicyCondition;
  return { op: 'and', clauses };
}

export async function createPolicyAction(_prev: AccessState, formData: FormData): Promise<AccessState> {
  try {
    const admin = await requireSuperAdmin();
    const appId = String(formData.get('appId') ?? '');
    const resource = String(formData.get('resource') ?? '').trim().toLowerCase();
    const rawAction = String(formData.get('action') ?? 'select');
    const effect = formData.get('effect') === 'deny' ? 'deny' : 'allow';
    const description = String(formData.get('description') ?? '').trim();
    const priority = Number(formData.get('priority') ?? 100);

    if (resource !== '*' && !IDENTIFIER_PATTERN.test(resource)) {
      throw new InfraError('VALIDATION_FAILED', 'resource must be a table name, or * for every table');
    }
    if (!POLICY_ACTIONS.includes(rawAction as PolicyAction)) {
      throw new InfraError('VALIDATION_FAILED', 'unknown action');
    }

    const condition = buildCondition(formData);

    // The one combination worth refusing outright from a form: an unconditional allow on every
    // table is "turn the rules engine off", and it should be a deliberate act, not two dropdowns.
    if (effect === 'allow' && resource === '*' && condition.op === 'always') {
      throw new InfraError(
        'VALIDATION_FAILED',
        'an unconditional allow on every table would disable row filtering entirely — write it per table if you really mean it',
      );
    }

    const policy = await createPolicy(db(), {
      appId,
      resource,
      action: rawAction as PolicyAction,
      effect,
      condition,
      priority: Number.isFinite(priority) ? priority : 100,
      description,
    });

    await recordAudit(db(), {
      appId,
      actorType: 'admin',
      actorId: admin.userId,
      action: 'policy.created',
      targetType: 'policy',
      targetId: policy.id,
      meta: { resource, action: rawAction, effect },
    });

    revalidatePath(`/apps/${appId}/access`);
    return ok(`policy on ${resource}.${rawAction} created`);
  } catch (error) {
    return failed(error, 'could not create that policy');
  }
}

export async function togglePolicyAction(
  appId: string,
  policyId: string,
  enabled: boolean,
): Promise<AccessState> {
  try {
    const admin = await requireSuperAdmin();
    await setPolicyEnabled(db(), policyId, enabled);

    await recordAudit(db(), {
      appId,
      actorType: 'admin',
      actorId: admin.userId,
      action: 'policy.updated',
      targetType: 'policy',
      targetId: policyId,
      meta: { enabled },
    });

    revalidatePath(`/apps/${appId}/access`);
    return ok(enabled ? 'policy enabled' : 'policy disabled');
  } catch (error) {
    return failed(error, 'could not change that policy');
  }
}

export async function deletePolicyAction(appId: string, policyId: string): Promise<AccessState> {
  try {
    const admin = await requireSuperAdmin();
    await deletePolicy(db(), policyId);

    await recordAudit(db(), {
      appId,
      actorType: 'admin',
      actorId: admin.userId,
      action: 'policy.deleted',
      targetType: 'policy',
      targetId: policyId,
    });

    revalidatePath(`/apps/${appId}/access`);
    return ok('policy deleted');
  } catch (error) {
    return failed(error, 'could not delete that policy');
  }
}
