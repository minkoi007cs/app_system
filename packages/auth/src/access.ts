/**
 * The single authorisation entry point.
 *
 * Every data path goes through `checkAccess`. It runs the two layers in order and returns not
 * just a yes/no but the WHERE fragment the caller must append — so there is no way to be
 * "allowed" without also carrying the row filter that allowance depends on.
 *
 *   1. RBAC — does this subject's role permit `resource:action` at all?
 *   2. ABAC — on which rows? (default deny; explicit deny beats any allow)
 */
import {
  compileDecision,
  decide,
  hasPermission,
  InfraError,
  type CompiledCondition,
  type PolicyAction,
  type PolicyDecision,
  type PolicySubject,
  type SqlDialect,
} from '@infra/core';
import {
  effectivePermissions,
  listPolicies,
  recordAuditAsync,
  type MasterDatabase,
  type SubjectType,
} from '@infra/db';

export interface AccessRequest {
  subjectType: SubjectType;
  subjectId: string;
  appId: string;
  workspaceId?: string | null;
  resource: string;
  action: PolicyAction;
  dialect: SqlDialect;
  /** Where the compiled parameters should start numbering (postgres $n). */
  paramOffset?: number;
}

export interface AccessResult {
  allowed: boolean;
  /** 'rbac' when the role lacked the permission; 'abac' when policies refused the rows. */
  deniedBy: 'rbac' | 'abac' | null;
  reason: string;
  roles: string[];
  permissions: string[];
  decision: PolicyDecision | null;
  /** Append to the query. On a denial this is `1 = 0`, so a caller that forgets to check still fails closed. */
  condition: CompiledCondition;
}

/** RBAC verbs are coarse; policy actions are SQL verbs. This is the bridge. */
const ACTION_TO_PERMISSION: Readonly<Record<PolicyAction, string>> = {
  select: 'read',
  insert: 'create',
  update: 'write',
  delete: 'delete',
};

export async function checkAccess(db: MasterDatabase, request: AccessRequest): Promise<AccessResult> {
  const denied = (deniedBy: 'rbac' | 'abac', reason: string, extra: Partial<AccessResult> = {}): AccessResult => ({
    allowed: false,
    deniedBy,
    reason,
    roles: [],
    permissions: [],
    decision: null,
    // Fail closed: even a caller that ignores `allowed` gets a query that returns nothing.
    condition: { sql: '1 = 0', params: [] },
    ...extra,
  });

  const { roleKeys, permissions } = await effectivePermissions(
    db,
    request.subjectType,
    request.subjectId,
    request.appId,
  );

  const required = `${request.resource}:${ACTION_TO_PERMISSION[request.action]}`;
  if (!hasPermission(permissions, required)) {
    recordAuditAsync(db, {
      appId: request.appId,
      actorType: request.subjectType === 'user' ? 'admin' : 'api_key',
      actorId: request.subjectId,
      action: 'access.denied',
      outcome: 'failure',
      targetType: request.resource,
      meta: { layer: 'rbac', required, roles: roleKeys },
    });
    return denied('rbac', `role does not grant ${required}`, { roles: roleKeys, permissions });
  }

  const subject: PolicySubject = {
    id: request.subjectId,
    appId: request.appId,
    roles: roleKeys,
    workspaceId: request.workspaceId ?? null,
  };

  const policies = await listPolicies(db, request.appId, request.resource, request.action);
  const decision = decide(policies, { resource: request.resource, action: request.action });
  const condition = compileDecision(decision, subject, request.dialect, request.paramOffset ?? 1);

  if (decision.effect === 'deny') {
    recordAuditAsync(db, {
      appId: request.appId,
      actorType: request.subjectType === 'user' ? 'admin' : 'api_key',
      actorId: request.subjectId,
      action: 'access.denied',
      outcome: 'failure',
      targetType: request.resource,
      meta: { layer: 'abac', reason: decision.reason, matched: decision.matched },
    });
    return denied('abac', decision.reason === 'default_deny' ? 'no policy allows this' : 'explicitly denied', {
      roles: roleKeys,
      permissions,
      decision,
    });
  }

  return {
    allowed: true,
    deniedBy: null,
    reason: 'allowed',
    roles: roleKeys,
    permissions,
    decision,
    condition,
  };
}

/** Throwing variant for call sites that treat a denial as an error. */
export async function requireAccess(db: MasterDatabase, request: AccessRequest): Promise<AccessResult> {
  const result = await checkAccess(db, request);
  if (!result.allowed) {
    throw new InfraError('FORBIDDEN_SCOPE', result.reason, {
      details: { resource: request.resource, action: request.action, deniedBy: result.deniedBy },
    });
  }
  return result;
}
