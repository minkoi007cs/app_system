/**
 * T7.6 — attacking the gateway on purpose.
 *
 * These tests are written from the attacker's side: each one is an attempt to get a value into the
 * SQL text, to widen a policy condition, or to reach a table the subject has no claim on. They
 * assert what the attacker does NOT get, which is why several check for the absence of a string
 * rather than the presence of one — a defence that produces plausible-looking SQL while leaking is
 * exactly the failure a "does it return rows" test would miss.
 */
import { describe, expect, it } from 'vitest';
import { InfraError } from '../src/errors.js';
import { parseQuerySpec, type QuerySpec } from '../src/query-dsl.js';
import { compileQuerySpec } from '../src/query-compiler.js';
import {
  compileDecision,
  decide,
  evaluateDecisionForRow,
  type Policy,
  type PolicySubject,
} from '../src/policy.js';

const victim: PolicySubject = { id: 'user_1', appId: 'app_1', roles: ['member'], workspaceId: 'ws_1' };

const ownRows: Policy = {
  id: 'p_own',
  resource: 'notes',
  action: 'select',
  effect: 'allow',
  condition: { op: 'eq', field: 'owner_id', value: { from: 'subject', path: 'id' } },
  priority: 10,
  enabled: true,
};

const guard = (policies: Policy[], action: QuerySpec['action'] = 'select') => {
  const decision = decide(policies, { resource: 'notes', action });
  return (startIndex: number, dialect: 'postgres' | 'libsql') =>
    compileDecision(decision, victim, dialect, startIndex);
};

const refused = (raw: unknown) => expect(() => parseQuerySpec(raw)).toThrowError(InfraError);

const NEWLINE = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(39);
const DQUOTE = String.fromCharCode(34);
const BACKTICK = String.fromCharCode(96);

// ── 1. injection through every string the caller controls ────────────────────

describe('injection attempts', () => {
  const PAYLOADS = [
    QUOTE + '; drop table notes; --',
    DQUOTE + ' or ' + DQUOTE + '1' + DQUOTE + '=' + DQUOTE + '1',
    '1; delete from users',
    'id) union select password from users --',
    '*/ union all select 1 --',
    'id' + NEWLINE + ', (select 1)',
    // A dotless i: it reads as an identifier and is not one.
    String.fromCharCode(305) + 'd',
    'ID; --',
  ];

  it('refuses every payload as a resource name', () => {
    for (const payload of PAYLOADS) refused({ resource: payload });
  });

  it('trims surrounding whitespace rather than refusing it', () => {
    // Documented rather than assumed: "notes " is a formatting slip, not an attack, and the
    // trimmed name still has to pass the identifier check.
    expect(parseQuerySpec({ resource: '  notes  ' }).resource).toBe('notes');
    refused({ resource: 'my notes' });
  });

  it('refuses every payload as a column name, in all four positions', () => {
    for (const payload of PAYLOADS) {
      refused({ resource: 'notes', select: [payload] });
      refused({ resource: 'notes', filters: [{ column: payload, op: 'eq', value: 1 }] });
      refused({ resource: 'notes', order: [{ column: payload, direction: 'asc' }] });
      refused({ resource: 'notes', action: 'insert', values: { title: 'x' }, returning: [payload] });
    }
  });

  it('refuses a payload as an inserted column name', () => {
    for (const payload of PAYLOADS) {
      refused({ resource: 'notes', action: 'insert', values: { [payload]: 'x' } });
    }
  });

  it('carries an injection payload through as a bound value, never as text', () => {
    // The payload is allowed as a *value* — that is the point of binding. It must not appear in
    // the statement.
    for (const payload of PAYLOADS) {
      const compiled = compileQuerySpec(
        parseQuerySpec({ resource: 'notes', filters: [{ column: 'title', op: 'eq', value: payload }] }),
        { dialect: 'postgres' },
      );
      expect(compiled.sql).not.toContain(payload);
      expect(compiled.params).toContain(payload);
    }
  });

  it('keeps an ilike pattern out of the statement text', () => {
    const payload = '%' + QUOTE + ' or 1=1 --';
    const compiled = compileQuerySpec(
      parseQuerySpec({ resource: 'notes', filters: [{ column: 'title', op: 'ilike', value: payload }] }),
      { dialect: 'libsql' },
    );
    expect(compiled.sql).not.toContain('or 1=1');
    expect(compiled.params).toContain(payload);
  });

  it('never lets a caller string reach the sql, across a fuzzed sweep', () => {
    const alphabet = [QUOTE, DQUOTE, ';', '-', ' ', 'a', '1', BACKTICK, BACKSLASH, '%', '(', ')'];

    for (let i = 0; i < 300; i += 1) {
      const value = Array.from(
        { length: 8 },
        () => alphabet[Math.floor(Math.random() * alphabet.length)] ?? 'a',
      ).join('');

      const compiled = compileQuerySpec(
        parseQuerySpec({ resource: 'notes', filters: [{ column: 'body', op: 'eq', value }] }),
        { dialect: 'postgres' },
      );

      // The statement is fixed text plus placeholders; the value only ever lands in params.
      expect(compiled.sql).toBe('select * from "notes" where "body" = $1 limit $2');
      expect(compiled.params[0]).toBe(value);
    }
  });
});

// ── 2. prototype pollution through JSON keys ─────────────────────────────────

describe('prototype pollution', () => {
  it('refuses __proto__, constructor and prototype as column names', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      refused({ resource: 'notes', action: 'insert', values: { [key]: 'x' } });
      refused({ resource: 'notes', select: [key] });
      refused({ resource: 'notes', filters: [{ column: key, op: 'eq', value: 1 }] });
    }
  });

  it('does not pollute Object.prototype when such a payload is parsed', () => {
    const payload = JSON.parse(
      '{"resource":"notes","action":"insert","values":{"__proto__":{"polluted":true}}}',
    ) as unknown;

    try {
      parseQuerySpec(payload);
    } catch {
      /* refusal is the expected outcome */
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('refuses a nested object as a value rather than stringifying it', () => {
    refused({ resource: 'notes', action: 'insert', values: { meta: { a: 1 } } });
    refused({ resource: 'notes', filters: [{ column: 'meta', op: 'eq', value: { $ne: null } }] });
  });
});

// ── 3. trying to widen or escape the policy condition ────────────────────────

describe('policy bypass attempts', () => {
  it('cannot read another subject rows by filtering for them', () => {
    const compiled = compileQuerySpec(
      parseQuerySpec({ resource: 'notes', filters: [{ column: 'owner_id', op: 'eq', value: 'user_2' }] }),
      { dialect: 'postgres', condition: guard([ownRows]) },
    );

    // Both predicates survive and are ANDed; the statement is satisfiable by no row.
    expect(compiled.params.slice(0, 2)).toEqual(['user_1', 'user_2']);
    expect(compiled.sql).toContain(' and ');
  });

  it('cannot drop the condition by sending no filters at all', () => {
    const compiled = compileQuerySpec(parseQuerySpec({ resource: 'notes' }), {
      dialect: 'postgres',
      condition: guard([ownRows]),
    });
    expect(compiled.sql).toContain('"owner_id" = $1');
  });

  it('cannot escape by using an OR — the grammar has no OR between caller filters', () => {
    const spec = parseQuerySpec({
      resource: 'notes',
      filters: [
        { column: 'owner_id', op: 'eq', value: 'user_2' },
        { column: 'owner_id', op: 'is_not_null' },
      ],
    });
    const compiled = compileQuerySpec(spec, { dialect: 'postgres', condition: guard([ownRows]) });
    expect(compiled.sql).not.toContain(' or ');
  });

  it('cannot reach a resource no policy mentions', () => {
    const compiled = compileQuerySpec(parseQuerySpec({ resource: 'salaries' }), {
      dialect: 'postgres',
      condition: (startIndex, dialect) =>
        compileDecision(
          decide([ownRows], { resource: 'salaries', action: 'select' }),
          victim,
          dialect,
          startIndex,
        ),
    });
    expect(compiled.sql).toContain('(1 = 0)');
  });

  it('cannot borrow a select policy to perform a delete', () => {
    const compiled = compileQuerySpec(
      parseQuerySpec({
        resource: 'notes',
        action: 'delete',
        filters: [{ column: 'id', op: 'eq', value: 1 }],
      }),
      { dialect: 'postgres', condition: guard([ownRows], 'delete') },
    );
    // ownRows is a select policy; for delete the decision defaults to deny.
    expect(compiled.sql).toContain('(1 = 0)');
  });

  it('cannot insert a row owned by somebody else', () => {
    const insertPolicy: Policy = { ...ownRows, id: 'p_ins', action: 'insert' };
    const decision = decide([insertPolicy], { resource: 'notes', action: 'insert' });
    expect(evaluateDecisionForRow(decision, victim, { owner_id: 'user_2' }).satisfied).toBe(false);
  });

  it('cannot insert a row that simply omits the ownership column', () => {
    const insertPolicy: Policy = { ...ownRows, id: 'p_ins', action: 'insert' };
    const decision = decide([insertPolicy], { resource: 'notes', action: 'insert' });
    const result = evaluateDecisionForRow(decision, victim, { title: 'sneaky' });
    expect(result.satisfied).toBe(false);
    expect(result.undecidable).toContain('owner_id');
  });

  it('validates a path-supplied resource exactly like a body-supplied one', () => {
    // The endpoint passes the URL segment in as the fallback resource; it gets the same check.
    expect(() => parseQuerySpec({}, 'notes; drop table users')).toThrowError(InfraError);
    expect(parseQuerySpec({}, 'notes').resource).toBe('notes');
  });

  it('a body resource cannot override the path to reach another table unchecked', () => {
    // Both go through assertIdentifier; neither is privileged. Authorisation is by resource name,
    // and the name that wins is still a validated identifier the policy engine will see.
    expect(parseQuerySpec({ resource: 'other_table' }, 'notes').resource).toBe('other_table');
    refused({ resource: 'other table' });
  });
});

// ── 4. resource exhaustion ───────────────────────────────────────────────────

describe('resource exhaustion attempts', () => {
  it('refuses an unbounded read', () => {
    refused({ resource: 'notes', limit: 1_000_000 });
    expect(parseQuerySpec({ resource: 'notes' }).limit).toBeLessThanOrEqual(1_000);
  });

  it('allows a large offset but refuses one past the safe-integer bound', () => {
    expect(parseQuerySpec({ resource: 'notes', offset: 1_000_000 }).offset).toBe(1_000_000);
    refused({ resource: 'notes', offset: Number.MAX_SAFE_INTEGER + 10 });
  });

  it('refuses an oversized in-list, filter list and insert batch', () => {
    refused({
      resource: 'notes',
      filters: [{ column: 'id', op: 'in', values: Array.from({ length: 5_000 }, (_, i) => i) }],
    });
    refused({
      resource: 'notes',
      filters: Array.from({ length: 500 }, () => ({ column: 'id', op: 'eq', value: 1 })),
    });
    refused({
      resource: 'notes',
      action: 'insert',
      values: Array.from({ length: 5_000 }, () => ({ title: 'x' })),
    });
  });

  it('refuses a limit expressed as a string or a float', () => {
    refused({ resource: 'notes', limit: '999999' });
    refused({ resource: 'notes', limit: 10.5 });
    refused({ resource: 'notes', limit: -5 });
  });
});
