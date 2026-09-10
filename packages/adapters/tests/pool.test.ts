import { describe, expect, it } from 'vitest';
import { createAdapterPool } from '../src/index.js';
import { createFakeAdapter } from './fake-adapter.js';

describe('createAdapterPool', () => {
  it('returns a cached adapter and counts hits', () => {
    const pool = createAdapterPool();
    const adapter = createFakeAdapter();
    void pool.set('app-1', adapter);

    expect(pool.get('app-1')).toBe(adapter);
    expect(pool.get('missing')).toBeNull();
    expect(pool.stats()).toMatchObject({ size: 1, hits: 1, misses: 1 });
  });

  it('expires an entry once the TTL passes and closes it', async () => {
    let clock = 0;
    const pool = createAdapterPool({ ttlMs: 1000, now: () => clock });
    const adapter = createFakeAdapter();
    await pool.set('app-1', adapter);

    clock = 999;
    expect(pool.get('app-1')).toBe(adapter);

    clock = 1000;
    expect(pool.get('app-1')).toBeNull();
    await Promise.resolve();
    expect(adapter.closed()).toBe(true);
    expect(pool.stats().expirations).toBe(1);
  });

  it('evicts the least recently used adapter when full', async () => {
    let clock = 0;
    const pool = createAdapterPool({ max: 2, now: () => clock });
    const first = createFakeAdapter();
    const second = createFakeAdapter();
    const third = createFakeAdapter();

    await pool.set('a', first);
    clock = 1;
    await pool.set('b', second);
    clock = 2;
    pool.get('a'); // 'a' becomes most recently used, so 'b' is the victim
    clock = 3;
    await pool.set('c', third);

    expect(pool.has('b')).toBe(false);
    expect(pool.has('a')).toBe(true);
    expect(pool.has('c')).toBe(true);
    expect(pool.stats().evictions).toBe(1);
  });

  it('invalidate closes the adapter and drops it', async () => {
    const pool = createAdapterPool();
    const adapter = createFakeAdapter();
    await pool.set('app-1', adapter);
    await pool.invalidate('app-1');

    expect(pool.has('app-1')).toBe(false);
    expect(adapter.closed()).toBe(true);
  });

  it('clear closes everything', async () => {
    const pool = createAdapterPool();
    const adapters = [createFakeAdapter(), createFakeAdapter()];
    await pool.set('a', adapters[0]!);
    await pool.set('b', adapters[1]!);
    await pool.clear();

    expect(pool.stats().size).toBe(0);
    expect(adapters.every((adapter) => adapter.closed())).toBe(true);
  });
});
