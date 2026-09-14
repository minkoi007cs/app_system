import { describe, expect, it } from 'vitest';
import { compileQuerySpec, queryShape } from '../src/query-compiler.js';
import { parseQuerySpec, type QuerySpec } from '../src/query-dsl.js';
import { compileDecision, decide, type Policy, type PolicySubject } from '../src/policy.js';

const spec = (raw: unknown): QuerySpec => parseQuerySpec(raw);

describe('compileQuerySpec — parameterisation', () => {
  it('binds every caller value and puts none of them in the sql', () => {
    const compiled = compileQuerySpec(
      spec({
        resource: 'notes',
        filters: [
          { column: 'owner', op: 'eq', value: "rob'); drop table notes;--" },
          { column: 'tag', op: 'in', values: ['a', 'b'] },
        ],
      }),
      { dialect: 'postgres' },
    );

    expect(compiled.sql).not.toContain('drop table');
    expect(compiled.sql).not.toContain("rob");
    expect(compiled.params).toContain("rob'); drop table notes;--");
    expect(compiled.sql).toBe(
      'select * from "notes" where "owner" = $1 and "tag" in ($2, $3) limit $4',
    );
  });

  it('numbers postgres placeholders consecutively from one', () => {
    const compiled = compileQuerySpec(
      spec({
        resource: 'notes',
        filters: [
          { column: 'a', op: 'eq', value: 1 },
          { column: 'b', op: 'eq', value: 2 },
          { column: 'c', op: 'in', values: [3, 4, 5] },
        ],
        limit: 10,
        offset: 5,
      }),
      { dialect: 'postgres' },
    );

    const markers = [...compiled.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(markers).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(compiled.params).toHaveLength(markers.length);
  });

  it('uses positional markers on libsql, one per parameter', () => {
    const compiled = compileQuerySpec(
      spec({ resource: 'notes', filters: [{ column: 'a', op: 'in', values: [1, 2, 3] }] }),
      { dialect: 'libsql' },
    );

    expect(compiled.sql).toBe('select * from `notes` where `a` in (?, ?, ?) limit ?');
    expect((compiled.sql.match(/\?/g) ?? []).length).toBe(compiled.params.length);
  });

  it('quotes identifiers per dialect', () => {
    const pg = compileQuerySpec(spec({ resource: 'notes', select: ['id'] }), { dialect: 'postgres' });
    const lib = compileQuerySpec(spec({ resource: 'notes', select: ['id'] }), { dialect: 'libsql' });
    expect(pg.sql).toContain('"id"');
    expect(lib.sql).toContain('`id`');
  });

  it('binds limit and offset rather than interpolating them', () => {
    const compiled = compileQuerySpec(spec({ resource: 'notes', limit: 7, offset: 3 }), {
      dialect: 'postgres',
    });
    expect(compiled.sql).toContain('limit $1 offset $2');
    expect(compiled.params).toEqual([7, 3]);
  });
});

describe('compileQuerySpec — operators', () => {
  it('writes a null equality as IS NULL, which is what the caller meant', () => {
    const compiled = compileQuerySpec(
      spec({ resource: 'notes', filters: [{ column: 'deleted_at', op: 'eq', value: null }] }),
      { dialect: 'postgres' },
    );
    expect(compiled.sql).toContain('"deleted_at" is null');
    expect(compiled.params).toEqual([100]); // only the default limit
  });

  it('makes ilike case-insensitive identically on both dialects', () => {
    const pg = compileQuerySpec(
      spec({ resource: 'notes', filters: [{ column: 'title', op: 'ilike', value: '%Draft%' }] }),
      { dialect: 'postgres' },
    );
    const lib = compileQuerySpec(
      spec({ resource: 'notes', filters: [{ column: 'title', op: 'ilike', value: '%Draft%' }] }),
      { dialect: 'libsql' },
    );
    expect(pg.sql).toContain('lower("title") like lower($1)');
    expect(lib.sql).toContain('lower(`title`) like lower(?)');
    expect(pg.params[0]).toBe('%Draft%');
  });

  it('orders by validated columns only', () => {
    const compiled = compileQuerySpec(
      spec({ resource: 'notes', order: [{ column: 'created_at', direction: 'desc' }] }),
      { dialect: 'postgres' },
    );
    expect(compiled.sql).toContain('order by "created_at" desc');
  });
});

describe('compileQuerySpec — writes', () => {
  it('compiles a batch insert with one tuple per row', () => {
    const compiled = compileQuerySpec(
      spec({
        resource: 'notes',
        action: 'insert',
        values: [
          { title: 'a', done: false },
          { title: 'b', done: true },
        ],
        returning: ['id'],
      }),
      { dialect: 'postgres' },
    );

    expect(compiled.sql).toBe(
      'insert into "notes" ("title", "done") values ($1, $2), ($3, $4) returning "id"',
    );
    expect(compiled.params).toEqual(['a', false, 'b', true]);
  });

  it('binds SET before WHERE, in the order the driver will bind them', () => {
    const compiled = compileQuerySpec(
      spec({
        resource: 'notes',
        action: 'update',
        values: { title: 'new' },
        filters: [{ column: 'id', op: 'eq', value: 7 }],
      }),
      { dialect: 'postgres' },
    );

    expect(compiled.sql).toBe('update "notes" set "title" = $1 where "id" = $2');
    expect(compiled.params).toEqual(['new', 7]);
  });

  it('compiles a delete with its filter', () => {
    const compiled = compileQuerySpec(
      spec({ resource: 'notes', action: 'delete', filters: [{ column: 'id', op: 'eq', value: 1 }] }),
      { dialect: 'libsql' },
    );
    expect(compiled.sql).toBe('delete from `notes` where `id` = ?');
  });
});

// ── the part that matters: the server's condition and the caller's filters together ──────────

describe('policy injection', () => {
  const subject: PolicySubject = { id: 'user_1', appId: 'app_1', roles: ['member'], workspaceId: null };

  const ownRowsOnly: Policy = {
    id: 'p1',
    resource: 'notes',
    action: 'select',
    effect: 'allow',
    condition: { op: 'eq', field: 'owner_id', value: { from: 'subject', path: 'id' } },
    priority: 10,
    enabled: true,
  };

  const conditionFor = (policies: Policy[], action: 'select' | 'delete' = 'select') => {
    const decision = decide(policies, { resource: 'notes', action });
    // The dialect comes from the compiler, never from here — see ConditionCompiler.
    return (startIndex: number, dialect: 'postgres' | 'libsql') =>
      compileDecision(decision, subject, dialect, startIndex);
  };

  it('ANDs the server condition in front of the caller filters', () => {
    const compiled = compileQuerySpec(
      spec({ resource: 'notes', filters: [{ column: 'done', op: 'eq', value: false }] }),
      { dialect: 'postgres', condition: conditionFor([ownRowsOnly]) },
    );

    expect(compiled.sql).toBe(
      'select * from "notes" where (("owner_id" = $1)) and "done" = $2 limit $3',
    );
    expect(compiled.params).toEqual(['user_1', false, 100]);
  });

  it('keeps the two parameter streams in step — the classic off-by-one', () => {
    // On libsql a mis-numbered injection does not error, it shifts values silently. So the
    // assertion is on the parameter ORDER, not just the count.
    const compiled = compileQuerySpec(
      spec({
        resource: 'notes',
        filters: [
          { column: 'done', op: 'eq', value: false },
          { column: 'tag', op: 'in', values: ['x', 'y'] },
        ],
        limit: 5,
      }),
      { dialect: 'libsql', condition: conditionFor([ownRowsOnly]) },
    );

    expect(compiled.params).toEqual(['user_1', false, 'x', 'y', 5]);
    expect((compiled.sql.match(/\?/g) ?? []).length).toBe(compiled.params.length);
  });

  it('a caller filter cannot widen the result — it can only add another AND', () => {
    // The attempt: ask for someone else's rows explicitly.
    const compiled = compileQuerySpec(
      spec({ resource: 'notes', filters: [{ column: 'owner_id', op: 'eq', value: 'user_2' }] }),
      { dialect: 'postgres', condition: conditionFor([ownRowsOnly]) },
    );

    expect(compiled.sql).toContain('(("owner_id" = $1)) and "owner_id" = $2');
    expect(compiled.params.slice(0, 2)).toEqual(['user_1', 'user_2']);
    // Both must hold, so the statement returns nothing rather than another user's rows.
  });

  it('a denial compiles to a condition that can never be true', () => {
    const compiled = compileQuerySpec(spec({ resource: 'notes' }), {
      dialect: 'postgres',
      condition: conditionFor([]), // no policy → default deny
    });
    expect(compiled.sql).toContain('(1 = 0)');
  });

  it('a delete still carries the server condition', () => {
    const deletePolicy: Policy = { ...ownRowsOnly, id: 'p2', action: 'delete' };
    const compiled = compileQuerySpec(
      spec({ resource: 'notes', action: 'delete', filters: [{ column: 'id', op: 'eq', value: 9 }] }),
      { dialect: 'postgres', condition: conditionFor([deletePolicy], 'delete') },
    );
    expect(compiled.sql).toBe('delete from "notes" where (("owner_id" = $1)) and "id" = $2');
    expect(compiled.params).toEqual(['user_1', 9]);
  });

  it('an update binds SET first, then the condition, then the filters', () => {
    const updatePolicy: Policy = { ...ownRowsOnly, id: 'p3', action: 'update' };
    const decision = decide([updatePolicy], { resource: 'notes', action: 'update' });
    const compiled = compileQuerySpec(
      spec({
        resource: 'notes',
        action: 'update',
        values: { title: 'renamed' },
        filters: [{ column: 'id', op: 'eq', value: 4 }],
      }),
      {
        dialect: 'postgres',
        condition: (startIndex, dialect) => compileDecision(decision, subject, dialect, startIndex),
      },
    );

    expect(compiled.sql).toBe(
      'update "notes" set "title" = $1 where (("owner_id" = $2)) and "id" = $3',
    );
    expect(compiled.params).toEqual(['renamed', 'user_1', 4]);
  });
});

describe('queryShape', () => {
  it('describes the statement without any values in it', () => {
    const shape = queryShape(
      spec({
        resource: 'notes',
        select: ['id', 'title'],
        filters: [{ column: 'owner', op: 'eq', value: 'secret-value' }],
      }),
    );
    expect(shape).toBe('select|notes|id+title|owner:eq');
    expect(shape).not.toContain('secret-value');
  });
});
