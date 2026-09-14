/**
 * evaluateDecisionForRow — the INSERT path, where there is no WHERE clause to hang a policy on.
 */
import { describe, expect, it } from 'vitest';
import {
  decide,
  evaluateConditionForRow,
  evaluateDecisionForRow,
  type Policy,
  type PolicySubject,
} from '../src/policy.js';

const subject: PolicySubject = { id: 'user_1', appId: 'app_1', roles: ['member'], workspaceId: 'ws_1' };

const ownRows: Policy = {
  id: 'p1',
  resource: 'notes',
  action: 'insert',
  effect: 'allow',
  condition: { op: 'eq', field: 'owner_id', value: { from: 'subject', path: 'id' } },
  priority: 10,
  enabled: true,
};

describe('evaluateConditionForRow', () => {
  it('allows a row that matches the subject', () => {
    const result = evaluateConditionForRow(ownRows.condition, subject, {
      owner_id: 'user_1',
      title: 'hello',
    });
    expect(result).toEqual({ satisfied: true, undecidable: [] });
  });

  it('refuses a row claiming someone else', () => {
    const result = evaluateConditionForRow(ownRows.condition, subject, { owner_id: 'user_2' });
    expect(result.satisfied).toBe(false);
    expect(result.undecidable).toEqual([]);
  });

  it('reports a column the row does not set as undecidable, not as allowed', () => {
    // This is the case that matters: without owner_id the column takes the table DEFAULT, so
    // "the policy did not fail" is not the same as "the policy passed".
    const result = evaluateConditionForRow(ownRows.condition, subject, { title: 'hello' });
    expect(result.satisfied).toBe(false);
    expect(result.undecidable).toEqual(['owner_id']);
  });

  it('compares by identity, so "1" never satisfies a policy expecting 1', () => {
    const condition = { op: 'eq', field: 'n', value: { from: 'literal', value: 1 } } as const;
    expect(evaluateConditionForRow(condition, subject, { n: 1 }).satisfied).toBe(true);
    expect(evaluateConditionForRow(condition, subject, { n: '1' }).satisfied).toBe(false);
  });

  it('collects every missing column rather than stopping at the first', () => {
    const condition = {
      op: 'and',
      clauses: [
        { op: 'eq', field: 'owner_id', value: { from: 'subject', path: 'id' } },
        { op: 'eq', field: 'workspace_id', value: { from: 'subject', path: 'workspace_id' } },
      ],
    } as const;

    const result = evaluateConditionForRow(condition, subject, { title: 'x' });
    expect(result.undecidable.sort()).toEqual(['owner_id', 'workspace_id']);
  });

  it('handles always, never, in and null checks', () => {
    expect(evaluateConditionForRow({ op: 'always' }, subject, {}).satisfied).toBe(true);
    expect(evaluateConditionForRow({ op: 'never' }, subject, {}).satisfied).toBe(false);
    expect(
      evaluateConditionForRow(
        { op: 'in', field: 'status', values: [{ from: 'literal', value: 'draft' }] },
        subject,
        { status: 'draft' },
      ).satisfied,
    ).toBe(true);
    expect(evaluateConditionForRow({ op: 'is_null', field: 'deleted_at' }, subject, {
      deleted_at: null,
    }).satisfied).toBe(true);
  });

  it('matches the subject workspace, not just the subject id', () => {
    const condition = {
      op: 'eq',
      field: 'workspace_id',
      value: { from: 'subject', path: 'workspace_id' },
    } as const;
    expect(evaluateConditionForRow(condition, subject, { workspace_id: 'ws_1' }).satisfied).toBe(true);
    expect(evaluateConditionForRow(condition, subject, { workspace_id: 'ws_2' }).satisfied).toBe(false);
  });
});

describe('evaluateDecisionForRow', () => {
  it('refuses when no policy allows the insert', () => {
    const decision = decide([], { resource: 'notes', action: 'insert' });
    expect(evaluateDecisionForRow(decision, subject, { owner_id: 'user_1' }).satisfied).toBe(false);
  });

  it('allows unconditionally when an allow carries no condition', () => {
    const open: Policy = { ...ownRows, id: 'p2', condition: { op: 'always' } };
    const decision = decide([open], { resource: 'notes', action: 'insert' });
    expect(evaluateDecisionForRow(decision, subject, { title: 'x' })).toEqual({
      satisfied: true,
      undecidable: [],
    });
  });

  it('applies the condition of a scoped allow', () => {
    const decision = decide([ownRows], { resource: 'notes', action: 'insert' });
    expect(evaluateDecisionForRow(decision, subject, { owner_id: 'user_1' }).satisfied).toBe(true);
    expect(evaluateDecisionForRow(decision, subject, { owner_id: 'user_2' }).satisfied).toBe(false);
  });

  it('an explicit deny beats an allow, whatever the row says', () => {
    const deny: Policy = { ...ownRows, id: 'p3', effect: 'deny', condition: { op: 'always' } };
    const decision = decide([ownRows, deny], { resource: 'notes', action: 'insert' });
    expect(evaluateDecisionForRow(decision, subject, { owner_id: 'user_1' }).satisfied).toBe(false);
  });
});
