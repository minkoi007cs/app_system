/**
 * The data gateway: a validated QuerySpec plus a subject, in; a parameterised statement, out.
 *
 * This is the single place where authorisation and SQL construction meet, and it is deliberately
 * the only way `/api/v1/data/:resource` can reach a tenant database. The ordering is not
 * negotiable:
 *
 *   1. `checkAccess` — RBAC, then ABAC. It returns a compiled row condition, and on any denial
 *      that condition is `1 = 0`, so even a caller that ignores `allowed` gets nothing back.
 *   2. For `insert`, the condition cannot be attached to a WHERE clause, so the proposed row is
 *      evaluated against the policy directly — and refused when the row does not set a column the
 *      policy needs (see evaluateDecisionForRow).
 *   3. Compile, with the condition ANDed in. The caller's filters can only narrow.
 *
 * What this function never does is trust the request for anything that decides access: `appId`
 * comes from the verified API key, the subject from the verified access token, the dialect from
 * the app's own database config. The body supplies shape and values, nothing else.
 */
import {
  compileDecision,
  compileQuerySpec,
  evaluateDecisionForRow,
  InfraError,
  queryShape,
  type CompiledQuery,
  type PolicySubject,
  type QuerySpec,
  type SqlDialect,
} from '@infra/core';
import type { MasterDatabase, SubjectType } from '@infra/db';
import { checkAccess, type AccessResult } from './access.js';

export interface GatewaySubject {
  type: SubjectType;
  id: string;
  workspaceId?: string | null;
}

export interface GatewayRequest {
  appId: string;
  subject: GatewaySubject;
  spec: QuerySpec;
  dialect: SqlDialect;
}

export interface GatewayPlan {
  query: CompiledQuery;
  access: AccessResult;
  /** Statement shape for the audit log — carries no values by construction. */
  shape: string;
}

export async function planQuery(db: MasterDatabase, request: GatewayRequest): Promise<GatewayPlan> {
  const { spec, appId, dialect } = request;

  const access = await checkAccess(db, {
    subjectType: request.subject.type,
    subjectId: request.subject.id,
    appId,
    workspaceId: request.subject.workspaceId ?? null,
    resource: spec.resource,
    action: spec.action,
    dialect,
    // The offset is supplied at compile time instead, by the compiler that knows how many
    // parameters precede it — see the condition callback below.
    paramOffset: 1,
  });

  if (!access.allowed) {
    throw new InfraError('FORBIDDEN_SCOPE', access.reason, {
      details: { resource: spec.resource, action: spec.action, deniedBy: access.deniedBy },
    });
  }

  const policySubject: PolicySubject = {
    id: request.subject.id,
    appId,
    roles: access.roles,
    workspaceId: request.subject.workspaceId ?? null,
  };

  if (spec.action === 'insert') {
    assertRowsSatisfyPolicy(spec, access, policySubject);
    // An insert has no WHERE, so nothing is injected into the statement; the check above is the
    // enforcement, and it has already run.
    return {
      query: compileQuerySpec(spec, { dialect }),
      access,
      shape: queryShape(spec),
    };
  }

  const query = compileQuerySpec(spec, {
    dialect,
    // Re-compiled here rather than reusing access.condition: the query compiler is the only thing
    // that knows the final placeholder index and dialect, and a condition numbered against a guess
    // binds every later value to the wrong column.
    condition: (startIndex, compilerDialect) => {
      if (access.decision === null) {
        // Unreachable while `allowed` is true, but a decision that went missing must not silently
        // become "no condition" — that would turn a scoped allow into a table-wide one.
        return { sql: '1 = 0', params: [] };
      }
      return compileDecision(access.decision, policySubject, compilerDialect, startIndex);
    },
  });

  return { query, access, shape: queryShape(spec) };
}

function assertRowsSatisfyPolicy(
  spec: QuerySpec,
  access: AccessResult,
  subject: PolicySubject,
): void {
  if (access.decision === null) {
    throw new InfraError('FORBIDDEN_SCOPE', 'no policy decision for this insert');
  }

  for (const [index, row] of spec.values.entries()) {
    const evaluation = evaluateDecisionForRow(access.decision, subject, row);

    if (evaluation.undecidable.length > 0) {
      // Fail closed and say which column is missing: this is a request the caller can fix, and
      // the column name is their own schema, not a secret.
      throw new InfraError(
        'FORBIDDEN_SCOPE',
        `values[${index}] must set ${evaluation.undecidable.join(', ')} for the policy to allow it`,
        { details: { row: index, missing: evaluation.undecidable } },
      );
    }

    if (!evaluation.satisfied) {
      throw new InfraError('FORBIDDEN_SCOPE', `values[${index}] is not allowed by policy`, {
        details: { row: index },
      });
    }
  }
}
