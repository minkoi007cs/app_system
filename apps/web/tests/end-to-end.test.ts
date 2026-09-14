/**
 * T8.7 — the seam between the SDK and the gateway.
 *
 * Every other test in this repo exercises one package. This one crosses all of them: it takes the
 * exact JSON the SDK's builder puts on the wire, feeds it to the parser the endpoint actually uses,
 * compiles it with a real policy decision, and checks the statement that comes out.
 *
 * That seam is where a platform quietly breaks. The SDK ships from one package and the grammar from
 * another; add an operator to the builder and forget the grammar, and the failure appears only in a
 * child app, at runtime, as a 422 nobody can explain from either side. So the contract test below
 * enumerates the builder's whole vocabulary rather than sampling it.
 */
import { describe, expect, it } from 'vitest';
import { QueryBuilder } from '@infra/sdk';
import {
  compileDecision,
  compileQuerySpec,
  decide,
  parseQuerySpec,
  type Policy,
  type PolicySubject,
} from '@infra/core';

const clientOptions = { baseUrl: 'https://infra.test', apiKey: 'pk_live_' + 'a'.repeat(32) };
const notes = <R = Record<string, unknown>>() => new QueryBuilder<R>(clientOptions as never, 'notes');

const subject: PolicySubject = { id: 'user_alice', appId: 'app_1', roles: ['member'], workspaceId: null };

const ownRows = (action: Policy['action']): Policy => ({
  id: `p_${action}`,
  resource: 'notes',
  action,
  effect: 'allow',
  condition: { op: 'eq', field: 'owner_id', value: { from: 'subject', path: 'id' } },
  priority: 10,
  enabled: true,
});

/** The path a request takes on the server, minus the two database lookups. */
function throughGateway(payload: unknown, policies: Policy[], action: Policy['action'] = 'select') {
  const spec = parseQuerySpec(payload, 'notes');
  const decision = decide(policies, { resource: spec.resource, action });

  return compileQuerySpec(spec, {
    dialect: 'postgres',
    condition: (startIndex, dialect) => compileDecision(decision, subject, dialect, startIndex),
  });
}

describe('sdk payload → gateway', () => {
  it('turns the README example into the statement it promises', () => {
    const payload = notes()
      .select('id', 'title', 'created_at')
      .eq('done', false)
      .order('created_at', 'desc')
      .limit(20)
      .toJSON();

    const compiled = throughGateway(payload, [ownRows('select')]);

    expect(compiled.sql).toBe(
      'select "id", "title", "created_at" from "notes" ' +
        'where (("owner_id" = $1)) and "done" = $2 ' +
        'order by "created_at" desc limit $3',
    );
    expect(compiled.params).toEqual(['user_alice', false, 20]);
  });

  it('adds the ownership filter to a query that never mentions it', () => {
    // The app asked for "all notes". It gets its own.
    const compiled = throughGateway(notes().toJSON(), [ownRows('select')]);
    expect(compiled.sql).toContain('"owner_id" = $1');
    expect(compiled.params[0]).toBe('user_alice');
  });

  it('returns nothing when the app asks for another person rows', () => {
    const payload = notes().eq('owner_id', 'user_bob').toJSON();
    const compiled = throughGateway(payload, [ownRows('select')]);

    // Both predicates are present and ANDed, so no row can satisfy the statement.
    expect(compiled.params.slice(0, 2)).toEqual(['user_alice', 'user_bob']);
  });

  it('denies everything when the app has written no policy', () => {
    const compiled = throughGateway(notes().toJSON(), []);
    expect(compiled.sql).toContain('(1 = 0)');
  });

  it('carries an insert through with its values bound', () => {
    const payload = notes().insert({ title: 'from the sdk', owner_id: 'user_alice' }).returning('id').toJSON();
    const spec = parseQuerySpec(payload, 'notes');
    const compiled = compileQuerySpec(spec, { dialect: 'postgres' });

    expect(compiled.sql).toBe(
      'insert into "notes" ("title", "owner_id") values ($1, $2) returning "id"',
    );
    expect(compiled.params).toEqual(['from the sdk', 'user_alice']);
  });

  it('keeps an update scoped by both the policy and the app filter', () => {
    const payload = notes().update({ done: true }).eq('id', 42).toJSON();
    const compiled = throughGateway(payload, [ownRows('update')], 'update');

    expect(compiled.sql).toBe(
      'update "notes" set "done" = $1 where (("owner_id" = $2)) and "id" = $3',
    );
    expect(compiled.params).toEqual([true, 'user_alice', 42]);
  });

  it('compiles the same payload for libsql without changing a single value', () => {
    const payload = notes().select('id').eq('done', false).limit(5).toJSON();

    const postgres = compileQuerySpec(parseQuerySpec(payload, 'notes'), { dialect: 'postgres' });
    const libsql = compileQuerySpec(parseQuerySpec(payload, 'notes'), { dialect: 'libsql' });

    expect(postgres.params).toEqual(libsql.params);
    expect(postgres.sql).toContain('$1');
    expect(libsql.sql).toContain('?');
  });
});

describe('vocabulary contract', () => {
  it('the grammar accepts every filter the builder can emit', () => {
    // Enumerated, not sampled: an operator added to one side and not the other fails here rather
    // than in somebody's app.
    const builder = notes()
      .eq('a', 1)
      .neq('b', 'x')
      .gt('c', 1)
      .gte('d', 2)
      .lt('e', 3)
      .lte('f', 4)
      .ilike('g', '%draft%')
      .in('h', [1, 2])
      .notIn('i', ['x'])
      .isNull('j')
      .isNotNull('k');

    const spec = parseQuerySpec(builder.toJSON(), 'notes');
    expect(spec.filters).toHaveLength(11);
    expect(spec.filters.map((filter) => filter.op)).toEqual([
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'ilike',
      'in',
      'not_in',
      'is_null',
      'is_not_null',
    ]);
  });

  it('the grammar accepts every action the builder can emit', () => {
    expect(parseQuerySpec(notes().toJSON(), 'notes').action).toBe('select');
    expect(parseQuerySpec(notes().insert({ a: 1 }).toJSON(), 'notes').action).toBe('insert');
    expect(parseQuerySpec(notes().update({ a: 1 }).eq('id', 1).toJSON(), 'notes').action).toBe('update');
    expect(parseQuerySpec(notes().delete().eq('id', 1).toJSON(), 'notes').action).toBe('delete');
  });

  it('the builder omits empty fields, and the grammar treats their absence as the default', () => {
    const payload = notes().toJSON();
    expect(Object.keys(payload)).toEqual(['action']);

    const spec = parseQuerySpec(payload, 'notes');
    expect(spec.select).toEqual([]);
    expect(spec.filters).toEqual([]);
    expect(spec.limit).toBeGreaterThan(0);
  });

  it('a builder payload never carries a key the grammar would reject', () => {
    const payload = notes()
      .select(['id'])
      .eq('a', 1)
      .order('b')
      .limit(1)
      .offset(1)
      .returning('id')
      .toJSON();

    // parseQuerySpec refuses unknown keys, so this passing is the assertion.
    expect(() => parseQuerySpec(payload, 'notes')).not.toThrow();
  });
});
