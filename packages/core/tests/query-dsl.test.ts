import { describe, expect, it } from 'vitest';
import { InfraError } from '../src/errors.js';
import {
  DEFAULT_LIMIT,
  MAX_FILTERS,
  MAX_IN_VALUES,
  MAX_INSERT_ROWS,
  MAX_LIMIT,
  parseQuerySpec,
} from '../src/query-dsl.js';

const ok = (raw: unknown) => parseQuerySpec(raw);
const bad = (raw: unknown) => expect(() => parseQuerySpec(raw)).toThrowError(InfraError);

describe('parseQuerySpec — shape', () => {
  it('accepts a minimal select and fills in the defaults', () => {
    const spec = ok({ resource: 'notes' });
    expect(spec).toMatchObject({
      resource: 'notes',
      action: 'select',
      select: [],
      filters: [],
      limit: DEFAULT_LIMIT,
      offset: 0,
    });
  });

  it('takes the resource from the path when the body omits it', () => {
    expect(parseQuerySpec({}, 'todos').resource).toBe('todos');
  });

  it('normalises identifiers to lower case', () => {
    expect(ok({ resource: 'Notes', select: ['ID', 'Title'] }).select).toEqual(['id', 'title']);
  });

  it('refuses an unknown top-level key instead of ignoring it', () => {
    // The reason this matters: a client that sends `wheres` and gets an unfiltered result
    // believes it filtered.
    bad({ resource: 'notes', wheres: [] });
    bad({ resource: 'notes', where: [] });
    bad({ resource: 'notes', having: 'x' });
  });

  it('refuses an unknown key inside a filter', () => {
    bad({ resource: 'notes', filters: [{ column: 'id', op: 'eq', value: 1, raw: 'or 1=1' }] });
  });
});

describe('parseQuerySpec — identifiers', () => {
  it('refuses anything that is not a bare identifier', () => {
    for (const resource of [
      'notes; drop table users',
      'notes--',
      'public.notes',
      'notes u join secrets s',
      '"notes"',
      '`notes`',
      "notes' or '1'='1",
      '',
      '1notes',
      'a'.repeat(64),
    ]) {
      bad({ resource });
    }
  });

  it('refuses injected column names in select, filters, order and returning', () => {
    bad({ resource: 'notes', select: ['id, (select password from users)'] });
    bad({ resource: 'notes', filters: [{ column: 'id) or (1=1', op: 'eq', value: 1 }] });
    bad({ resource: 'notes', order: [{ column: 'id; drop table x', direction: 'asc' }] });
    bad({ resource: 'notes', action: 'insert', values: { 'a)--': 1 }, returning: ['id--'] });
  });

  it('refuses a non-string identifier', () => {
    bad({ resource: 42 });
    bad({ resource: 'notes', select: [null] });
    bad({ resource: 'notes', filters: [{ column: { toString: 'x' }, op: 'eq', value: 1 }] });
  });
});

describe('parseQuerySpec — operators and values', () => {
  it('accepts only the closed operator set', () => {
    ok({ resource: 'notes', filters: [{ column: 'done', op: 'eq', value: false }] });
    bad({ resource: 'notes', filters: [{ column: 'done', op: 'regex', value: '.*' }] });
    bad({ resource: 'notes', filters: [{ column: 'done', op: 'LIKE', value: 'x' }] });
    // `like` is deliberately absent: it means different things on postgres and sqlite.
    bad({ resource: 'notes', filters: [{ column: 'title', op: 'like', value: 'x%' }] });
  });

  it('refuses objects and arrays as scalar values', () => {
    bad({ resource: 'notes', filters: [{ column: 'id', op: 'eq', value: { $gt: 0 } }] });
    bad({ resource: 'notes', filters: [{ column: 'id', op: 'eq', value: [1, 2] }] });
  });

  it('refuses NaN and Infinity', () => {
    bad({ resource: 'notes', filters: [{ column: 'n', op: 'gt', value: Number.POSITIVE_INFINITY }] });
    bad({ resource: 'notes', filters: [{ column: 'n', op: 'gt', value: Number.NaN }] });
  });

  it('accepts null and keeps it', () => {
    const spec = ok({ resource: 'notes', filters: [{ column: 'deleted_at', op: 'eq', value: null }] });
    expect(spec.filters[0]).toMatchObject({ op: 'eq', value: null });
  });

  it('requires values for in / not_in and forbids them for is_null', () => {
    bad({ resource: 'notes', filters: [{ column: 'id', op: 'in', value: 1 }] });
    bad({ resource: 'notes', filters: [{ column: 'id', op: 'in', values: [] }] });
    bad({ resource: 'notes', filters: [{ column: 'id', op: 'is_null', value: 1 }] });
    ok({ resource: 'notes', filters: [{ column: 'id', op: 'is_null' }] });
  });
});

describe('parseQuerySpec — limits', () => {
  it('caps limit and refuses a negative or fractional one', () => {
    expect(ok({ resource: 'notes', limit: 50 }).limit).toBe(50);
    bad({ resource: 'notes', limit: MAX_LIMIT + 1 });
    bad({ resource: 'notes', limit: -1 });
    bad({ resource: 'notes', limit: 1.5 });
    bad({ resource: 'notes', limit: '10' });
  });

  it('caps the number of filters, in-values and inserted rows', () => {
    const filter = { column: 'id', op: 'eq', value: 1 };
    bad({ resource: 'notes', filters: Array.from({ length: MAX_FILTERS + 1 }, () => filter) });
    bad({
      resource: 'notes',
      filters: [{ column: 'id', op: 'in', values: Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => i) }],
    });
    bad({
      resource: 'notes',
      action: 'insert',
      values: Array.from({ length: MAX_INSERT_ROWS + 1 }, () => ({ title: 'x' })),
    });
  });

  it('caps the ilike pattern length', () => {
    bad({ resource: 'notes', filters: [{ column: 'title', op: 'ilike', value: 'x'.repeat(201) }] });
  });
});

describe('parseQuerySpec — write safety', () => {
  it('refuses an update or delete with no filter', () => {
    // A permissive policy compiles to `1 = 1`; a filterless delete would then empty the table.
    bad({ resource: 'notes', action: 'delete' });
    bad({ resource: 'notes', action: 'update', values: { title: 'x' } });
    ok({ resource: 'notes', action: 'delete', filters: [{ column: 'id', op: 'eq', value: 1 }] });
  });

  it('requires values for insert and update, and forbids them elsewhere', () => {
    bad({ resource: 'notes', action: 'insert' });
    bad({ resource: 'notes', action: 'select', values: { title: 'x' } });
    bad({ resource: 'notes', action: 'delete', filters: [{ column: 'id', op: 'eq', value: 1 }], values: {} });
  });

  it('refuses a ragged insert batch rather than guessing the column list', () => {
    bad({ resource: 'notes', action: 'insert', values: [{ title: 'a' }, { title: 'b', done: true }] });
    ok({ resource: 'notes', action: 'insert', values: [{ title: 'a' }, { title: 'b' }] });
  });

  it('refuses an empty row', () => {
    bad({ resource: 'notes', action: 'insert', values: {} });
  });

  it('refuses filters on insert and order/limit on writes', () => {
    bad({
      resource: 'notes',
      action: 'insert',
      values: { title: 'x' },
      filters: [{ column: 'id', op: 'eq', value: 1 }],
    });
    bad({
      resource: 'notes',
      action: 'delete',
      filters: [{ column: 'id', op: 'eq', value: 1 }],
      limit: 1,
    });
  });

  it('accepts an array of one row for update only as a single object', () => {
    bad({ resource: 'notes', action: 'update', values: [{ title: 'x' }], filters: [{ column: 'id', op: 'eq', value: 1 }] });
  });
});

describe('parseQuerySpec — rejects non-objects', () => {
  it('refuses arrays, strings and null at the top level', () => {
    bad([]);
    bad('select * from notes');
    bad(null);
    bad(42);
  });
});
