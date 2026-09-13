/**
 * ABAC: the row-level half of authorisation.
 *
 * RBAC answers "may this role perform this action at all". A policy answers "on which rows",
 * by contributing a condition the server appends to every query. Two properties make it safe:
 *
 *   · **Default deny.** No matching allow means no access. A newly created app exposes nothing.
 *   · **Conditions reference the SUBJECT, never the request.** There is deliberately no
 *     `{ from: 'request' }` attribute — letting a policy read a client-supplied value would let
 *     the client choose its own filter, which is the same as having no filter.
 */
import { InfraError } from './errors.js';

export type PolicyEffect = 'allow' | 'deny';
export type PolicyAction = 'select' | 'insert' | 'update' | 'delete';

export type AttributeRef =
  | { from: 'subject'; path: 'id' | 'roles' | 'workspace_id' | 'app_id' }
  | { from: 'literal'; value: string | number | boolean | null };

export type PolicyCondition =
  | { op: 'always' }
  | { op: 'never' }
  | { op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'; field: string; value: AttributeRef }
  | { op: 'in' | 'not_in'; field: string; values: AttributeRef[] }
  | { op: 'is_null' | 'is_not_null'; field: string }
  | { op: 'and' | 'or'; clauses: PolicyCondition[] };

export interface Policy {
  id: string;
  resource: string;
  action: PolicyAction;
  effect: PolicyEffect;
  condition: PolicyCondition;
  /** Lower runs first. Ties are broken by id so evaluation is deterministic. */
  priority: number;
  enabled: boolean;
}

export interface PolicySubject {
  id: string;
  appId: string;
  roles: string[];
  workspaceId: string | null;
}

export interface PolicyRequest {
  resource: string;
  action: PolicyAction;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  /** Ids of the policies that produced this decision, in evaluation order. */
  matched: string[];
  /** Conditions the caller must apply to the query. Empty means "allowed unconditionally". */
  conditions: PolicyCondition[];
  reason: 'explicit_deny' | 'allow' | 'default_deny';
}

function relevant(policy: Policy, request: PolicyRequest): boolean {
  if (!policy.enabled) return false;
  if (policy.action !== request.action) return false;
  return policy.resource === '*' || policy.resource === request.resource;
}

/**
 * Deny wins, then allows accumulate. An `allow` whose condition is `never` contributes nothing,
 * which keeps a mis-written policy from opening a table by accident.
 */
export function decide(policies: readonly Policy[], request: PolicyRequest): PolicyDecision {
  const applicable = [...policies]
    .filter((policy) => relevant(policy, request))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const denies = applicable.filter((policy) => policy.effect === 'deny');
  if (denies.length > 0) {
    // A deny whose condition is `always` blocks outright; a conditional deny becomes a negative
    // filter the caller must apply.
    const unconditional = denies.find((policy) => policy.condition.op === 'always');
    if (unconditional !== undefined) {
      return { effect: 'deny', matched: [unconditional.id], conditions: [], reason: 'explicit_deny' };
    }
  }

  const allows = applicable.filter(
    (policy) => policy.effect === 'allow' && policy.condition.op !== 'never',
  );
  if (allows.length === 0) {
    return { effect: 'deny', matched: [], conditions: [], reason: 'default_deny' };
  }

  const conditions: PolicyCondition[] = [];
  // Several allows are alternatives: satisfy any one of them.
  const allowClause: PolicyCondition =
    allows.length === 1
      ? (allows[0] as Policy).condition
      : { op: 'or', clauses: allows.map((policy) => policy.condition) };
  if (allowClause.op !== 'always') conditions.push(allowClause);

  // Conditional denies subtract from whatever the allows granted.
  for (const deny of denies) {
    conditions.push(negate(deny.condition));
  }

  return {
    effect: 'allow',
    matched: [...allows.map((policy) => policy.id), ...denies.map((policy) => policy.id)],
    conditions,
    reason: 'allow',
  };
}

export function negate(condition: PolicyCondition): PolicyCondition {
  switch (condition.op) {
    case 'always':
      return { op: 'never' };
    case 'never':
      return { op: 'always' };
    case 'eq':
      return { op: 'neq', field: condition.field, value: condition.value };
    case 'neq':
      return { op: 'eq', field: condition.field, value: condition.value };
    case 'in':
      return { op: 'not_in', field: condition.field, values: condition.values };
    case 'not_in':
      return { op: 'in', field: condition.field, values: condition.values };
    case 'is_null':
      return { op: 'is_not_null', field: condition.field };
    case 'is_not_null':
      return { op: 'is_null', field: condition.field };
    case 'lt':
      return { op: 'gte', field: condition.field, value: condition.value };
    case 'lte':
      return { op: 'gt', field: condition.field, value: condition.value };
    case 'gt':
      return { op: 'lte', field: condition.field, value: condition.value };
    case 'gte':
      return { op: 'lt', field: condition.field, value: condition.value };
    case 'and':
      return { op: 'or', clauses: condition.clauses.map(negate) };
    case 'or':
      return { op: 'and', clauses: condition.clauses.map(negate) };
    default:
      throw new InfraError('VALIDATION_FAILED', 'unknown policy condition');
  }
}

// ── compiling to SQL ─────────────────────────────────────────────────────────

/** Column names are never interpolated blindly — only a strict identifier is accepted. */
export const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export type SqlDialect = 'postgres' | 'libsql';

export interface CompiledCondition {
  sql: string;
  params: unknown[];
}

function quoteIdentifier(field: string, dialect: SqlDialect): string {
  const value = field.trim().toLowerCase();
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new InfraError('VALIDATION_FAILED', `policy refers to an invalid column name: "${field}"`, {
      details: { field },
    });
  }
  return dialect === 'postgres' ? `"${value}"` : `\`${value}\``;
}

function resolveAttribute(ref: AttributeRef, subject: PolicySubject): unknown {
  if (ref.from === 'literal') return ref.value;
  switch (ref.path) {
    case 'id':
      return subject.id;
    case 'app_id':
      return subject.appId;
    case 'workspace_id':
      return subject.workspaceId;
    case 'roles':
      return subject.roles;
    default:
      throw new InfraError('VALIDATION_FAILED', 'unknown subject attribute');
  }
}

const COMPARISONS: Readonly<Record<string, string>> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/**
 * Turns a condition tree into a parameterised WHERE fragment.
 * Values always travel as parameters; only validated identifiers ever reach the SQL text.
 */
export function compileCondition(
  condition: PolicyCondition,
  subject: PolicySubject,
  dialect: SqlDialect,
  startIndex = 1,
): CompiledCondition {
  const params: unknown[] = [];

  const placeholder = (): string => (dialect === 'postgres' ? `$${startIndex + params.length}` : '?');

  const walk = (node: PolicyCondition): string => {
    switch (node.op) {
      case 'always':
        return '1 = 1';
      case 'never':
        return '1 = 0';
      case 'is_null':
        return `${quoteIdentifier(node.field, dialect)} is null`;
      case 'is_not_null':
        return `${quoteIdentifier(node.field, dialect)} is not null`;
      case 'eq':
      case 'neq':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte': {
        const column = quoteIdentifier(node.field, dialect);
        const value = resolveAttribute(node.value, subject);
        // A null comparison is written as IS NULL rather than "= null", which is never true.
        if (value === null) return node.op === 'eq' ? `${column} is null` : `${column} is not null`;
        const marker = placeholder();
        params.push(value);
        return `${column} ${COMPARISONS[node.op]} ${marker}`;
      }
      case 'in':
      case 'not_in': {
        const column = quoteIdentifier(node.field, dialect);
        const values = node.values.map((ref) => resolveAttribute(ref, subject)).flat();
        if (values.length === 0) return node.op === 'in' ? '1 = 0' : '1 = 1';
        const markers = values.map((value) => {
          const marker = placeholder();
          params.push(value);
          return marker;
        });
        return `${column} ${node.op === 'in' ? 'in' : 'not in'} (${markers.join(', ')})`;
      }
      case 'and':
      case 'or': {
        if (node.clauses.length === 0) return node.op === 'and' ? '1 = 1' : '1 = 0';
        const joined = node.clauses.map(walk).join(node.op === 'and' ? ' and ' : ' or ');
        return `(${joined})`;
      }
      default:
        throw new InfraError('VALIDATION_FAILED', 'unknown policy condition');
    }
  };

  return { sql: walk(condition), params };
}

/** Combines every condition from a decision into one WHERE fragment. */
export function compileDecision(
  decision: PolicyDecision,
  subject: PolicySubject,
  dialect: SqlDialect,
  startIndex = 1,
): CompiledCondition {
  if (decision.effect === 'deny') return { sql: '1 = 0', params: [] };
  if (decision.conditions.length === 0) return { sql: '1 = 1', params: [] };

  return compileCondition({ op: 'and', clauses: decision.conditions }, subject, dialect, startIndex);
}
