import { describe, expect, it } from 'vitest';
import { QueryBuilder } from '../src/query-builder.js';
import type { InfraClientOptions } from '../src/types.js';

const options = { baseUrl: 'https://infra.test', apiKey: 'pk_live_' + 'a'.repeat(32) } as InfraClientOptions;
const notes = <R = Record<string, unknown>>() => new QueryBuilder<R>(options, 'notes');

describe('QueryBuilder — payload', () => {
  it('defaults to a bare select', () => {
    expect(notes().toJSON()).toEqual({ action: 'select' });
  });

  it('builds the shape the gateway grammar expects', () => {
    const payload = notes()
      .select('id', 'title')
      .eq('done', false)
      .ilike('title', '%draft%')
      .in('tag', ['a', 'b'])
      .orderBy('created_at', 'desc')
      .limit(20)
      .offset(40)
      .toJSON();

    expect(payload).toEqual({
      action: 'select',
      select: ['id', 'title'],
      filters: [
        { column: 'done', op: 'eq', value: false },
        { column: 'title', op: 'ilike', value: '%draft%' },
        { column: 'tag', op: 'in', values: ['a', 'b'] },
      ],
      order: [{ column: 'created_at', direction: 'desc' }],
      limit: 20,
      offset: 40,
    });
  });

  it('omits every field the caller did not set — no empty arrays on the wire', () => {
    const payload = notes().eq('id', 1).toJSON();
    expect(Object.keys(payload).sort()).toEqual(['action', 'filters']);
  });

  it('covers each comparison operator', () => {
    const payload = notes().gt('a', 1).gte('b', 2).lt('c', 3).lte('d', 4).neq('e', 5).toJSON();
    expect(payload.filters?.map((f) => f.op)).toEqual(['gt', 'gte', 'lt', 'lte', 'neq']);
  });

  it('covers the null checks without a value', () => {
    const payload = notes().isNull('deleted_at').isNotNull('published_at').toJSON();
    expect(payload.filters).toEqual([
      { column: 'deleted_at', op: 'is_null' },
      { column: 'published_at', op: 'is_not_null' },
    ]);
  });

  it('builds insert, update and delete', () => {
    expect(notes().insert({ title: 'x' }).returning('id').toJSON()).toEqual({
      action: 'insert',
      values: { title: 'x' },
      returning: ['id'],
    });

    expect(notes().update({ title: 'y' }).eq('id', 1).toJSON()).toEqual({
      action: 'update',
      values: { title: 'y' },
      filters: [{ column: 'id', op: 'eq', value: 1 }],
    });

    expect(notes().delete().eq('id', 1).toJSON()).toEqual({
      action: 'delete',
      filters: [{ column: 'id', op: 'eq', value: 1 }],
    });
  });

  it('accepts a batch insert', () => {
    const payload = notes().insert([{ title: 'a' }, { title: 'b' }]).toJSON();
    expect(payload.values).toEqual([{ title: 'a' }, { title: 'b' }]);
  });

  it('is inert until run — building a query touches no network', async () => {
    // No fetch is stubbed here. If the builder called out during construction, this would throw.
    const builder = notes().select('id').eq('done', true);
    expect(builder.toJSON().action).toBe('select');
  });
});

describe('QueryBuilder — transport', () => {
  it('posts to the resource path with the built payload', async () => {
    const seen: Array<{ url: string; body: unknown; headers: Headers }> = [];
    const original = globalThis.fetch;

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen.push({
        url: url.toString(),
        body: JSON.parse(String(init?.body ?? '{}')),
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify({ data: { rows: [{ id: 1 }], rowCount: 1, durationMs: 3 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const result = await notes<{ id: number }>().select('id').eq('done', false).run();
      expect(result.error).toBeNull();
      expect(result.data?.rows).toEqual([{ id: 1 }]);

      const call = seen[0];
      expect(call?.url).toBe('https://infra.test/api/v1/data/notes');
      expect(call?.body).toEqual({
        action: 'select',
        select: ['id'],
        filters: [{ column: 'done', op: 'eq', value: false }],
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('escapes the resource in the path rather than trusting it', async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      seen.push(url.toString());
      return new Response(JSON.stringify({ data: { rows: [], rowCount: 0, durationMs: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await new QueryBuilder(options, '../admin/secrets').run();
      expect(seen[0]).toBe('https://infra.test/api/v1/data/..%2Fadmin%2Fsecrets');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('returns the error as a value, never as a throw', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'FORBIDDEN_SCOPE', message: 'nope', requestId: 'req_1' } }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    try {
      const result = await notes().eq('id', 1).run();
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('FORBIDDEN_SCOPE');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('can be awaited directly', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { rows: [{ id: 7 }], rowCount: 1, durationMs: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    try {
      const result = await notes<{ id: number }>().eq('id', 7);
      expect(result.data?.rows[0]).toEqual({ id: 7 });
    } finally {
      globalThis.fetch = original;
    }
  });
});
