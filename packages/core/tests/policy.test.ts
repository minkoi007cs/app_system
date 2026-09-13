import { describe, expect, it } from 'vitest';
import {
  compileCondition,
  compileDecision,
  decide,
  InfraError,
  negate,
  type Policy,
  type PolicyCondition,
  type PolicySubject,
} from '../src/index.js';

const subject: PolicySubject = {
  id: 'user_1',
  appId: 'app_1',
  roles: ['member'],
  workspaceId: null,
};

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    id: 'p1',
    resource: 'notes',
    action: 'select',
    effect: 'allow',
    condition: { op: 'always' },
    priority: 100,
    enabled: true,
    ...overrides,
  };
}

const ownRows: PolicyCondition = {
  op: 'eq',
  field: 'owner_id',
  value: { from: 'subject', path: 'id' },
};

describe('decide — default deny', () => {
  it('denies when no policy exists at all', () => {
    expect(decide([], { resource: 'notes', action: 'select' })).toMatchObject({
      effect: 'deny',
      reason: 'default_deny',
    });
  });

  it('denies when policies exist for another resource or action', () => {
    const policies = [policy({ resource: 'files' }), policy({ id: 'p2', action: 'delete' })];
    expect(decide(policies, { resource: 'notes', action: 'select' }).effect).toBe('deny');
  });

  it('ignores disabled policies', () => {
    expect(decide([policy({ enabled: false })], { resource: 'notes', action: 'select' }).effect).toBe(
      'deny',
    );
  });

  it('treats an allow whose condition is never as no allow at all', () => {
    expect(
      decide([policy({ condition: { op: 'never' } })], { resource: 'notes', action: 'select' }).effect,
    ).toBe('deny');
  });
});

describe('decide — allow', () => {
  it('allows unconditionally when the condition is always', () => {
    const decision = decide([policy()], { resource: 'notes', action: 'select' });
    expect(decision).toMatchObject({ effect: 'allow', conditions: [], reason: 'allow' });
  });

  it('returns the condition the caller must apply', () => {
    const decision = decide([policy({ condition: ownRows })], { resource: 'notes', action: 'select' });
    expect(decision.effect).toBe('allow');
    expect(decision.conditions).toEqual([ownRows]);
  });

  it('treats several allows as alternatives', () => {
    const decision = decide(
      [
        policy({ id: 'a', condition: ownRows }),
        policy({ id: 'b', condition: { op: 'eq', field: 'public', value: { from: 'literal', value: true } } }),
      ],
      { resource: 'notes', action: 'select' },
    );
    expect(decision.conditions[0]?.op).toBe('or');
  });

  it('matches a wildcard resource policy', () => {
    expect(decide([policy({ resource: '*' })], { resource: 'anything', action: 'select' }).effect).toBe(
      'allow',
    );
  });
});

describe('decide — deny wins', () => {
  it('an unconditional deny beats every allow', () => {
    const decision = decide([policy(), policy({ id: 'd', effect: 'deny' })], {
      resource: 'notes',
      action: 'select',
    });
    expect(decision).toMatchObject({ effect: 'deny', reason: 'explicit_deny' });
  });

  it('a conditional deny becomes a negative filter on top of the allow', () => {
    const decision = decide(
      [
        policy({ condition: { op: 'always' } }),
        policy({
          id: 'd',
          effect: 'deny',
          condition: { op: 'eq', field: 'archived', value: { from: 'literal', value: true } },
        }),
      ],
      { resource: 'notes', action: 'select' },
    );
    expect(decision.effect).toBe('allow');
    expect(decision.conditions).toContainEqual({
      op: 'neq',
      field: 'archived',
      value: { from: 'literal', value: true },
    });
  });

  it('is deterministic regardless of input order', () => {
    const a = policy({ id: 'a', condition: ownRows, priority: 10 });
    const b = policy({ id: 'b', condition: { op: 'always' }, priority: 20 });
    const first = decide([a, b], { resource: 'notes', action: 'select' });
    const second = decide([b, a], { resource: 'notes', action: 'select' });
    expect(first).toEqual(second);
  });
});

describe('negate', () => {
  it('flips every operator and is its own inverse', () => {
    const cases: PolicyCondition[] = [
      { op: 'always' },
      { op: 'eq', field: 'a', value: { from: 'literal', value: 1 } },
      { op: 'in', field: 'a', values: [{ from: 'literal', value: 1 }] },
      { op: 'is_null', field: 'a' },
      { op: 'lt', field: 'a', value: { from: 'literal', value: 1 } },
      { op: 'and', clauses: [{ op: 'is_null', field: 'a' }] },
    ];
    for (const condition of cases) expect(negate(negate(condition))).toEqual(condition);
  });
});

describe('compileCondition — postgres', () => {
  it('binds subject attributes as parameters, never as text', () => {
    const compiled = compileCondition(ownRows, subject, 'postgres');
    expect(compiled.sql).toBe('"owner_id" = $1');
    expect(compiled.params).toEqual(['user_1']);
  });

  it('numbers placeholders from the offset the caller gives', () => {
    const compiled = compileCondition(ownRows, subject, 'postgres', 4);
    expect(compiled.sql).toBe('"owner_id" = $4');
  });

  it('uses ? for libsql', () => {
    const compiled = compileCondition(ownRows, subject, 'libsql');
    expect(compiled.sql).toBe('`owner_id` = ?');
  });

  it('rejects a column name that is not a plain identifier', () => {
    for (const field of ['owner_id; drop table notes', 'owner id', '1owner', 'owner-id', '"owner"']) {
      expect(() =>
        compileCondition({ op: 'eq', field, value: { from: 'literal', value: 1 } }, subject, 'postgres'),
      ).toThrowError(InfraError);
    }
  });

  it('writes IS NULL rather than = null, which is never true', () => {
    const compiled = compileCondition(
      { op: 'eq', field: 'workspace_id', value: { from: 'subject', path: 'workspace_id' } },
      subject,
      'postgres',
    );
    expect(compiled.sql).toBe('"workspace_id" is null');
    expect(compiled.params).toEqual([]);
  });

  it('expands a subject array into a parameter list', () => {
    const compiled = compileCondition(
      { op: 'in', field: 'role', values: [{ from: 'subject', path: 'roles' }] },
      { ...subject, roles: ['member', 'admin'] },
      'postgres',
    );
    expect(compiled.sql).toBe('"role" in ($1, $2)');
    expect(compiled.params).toEqual(['member', 'admin']);
  });

  it('turns an empty IN into a false constant instead of invalid sql', () => {
    const compiled = compileCondition({ op: 'in', field: 'role', values: [] }, subject, 'postgres');
    expect(compiled.sql).toBe('1 = 0');
  });

  it('nests and/or with parentheses', () => {
    const compiled = compileCondition(
      {
        op: 'or',
        clauses: [ownRows, { op: 'eq', field: 'public', value: { from: 'literal', value: true } }],
      },
      subject,
      'postgres',
    );
    expect(compiled.sql).toBe('("owner_id" = $1 or "public" = $2)');
    expect(compiled.params).toEqual(['user_1', true]);
  });
});

describe('compileDecision', () => {
  it('compiles a deny to a condition that can never be true', () => {
    const decision = decide([], { resource: 'notes', action: 'select' });
    expect(compileDecision(decision, subject, 'postgres')).toEqual({ sql: '1 = 0', params: [] });
  });

  it('compiles an unconditional allow to a condition that is always true', () => {
    const decision = decide([policy()], { resource: 'notes', action: 'select' });
    expect(compileDecision(decision, subject, 'postgres')).toEqual({ sql: '1 = 1', params: [] });
  });

  it('ands every condition together', () => {
    const decision = decide(
      [
        policy({ condition: ownRows }),
        policy({
          id: 'd',
          effect: 'deny',
          condition: { op: 'eq', field: 'archived', value: { from: 'literal', value: true } },
        }),
      ],
      { resource: 'notes', action: 'select' },
    );
    const compiled = compileDecision(decision, subject, 'postgres');
    expect(compiled.sql).toBe('("owner_id" = $1 and "archived" <> $2)');
    expect(compiled.params).toEqual(['user_1', true]);
  });
});
