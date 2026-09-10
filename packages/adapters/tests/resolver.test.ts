import { describe, expect, it, vi } from 'vitest';
import { InfraError } from '@infra/core';
import { createConnectionResolver, type ResolvedConfig } from '../src/index.js';
import { createFakeAdapter } from './fake-adapter.js';

const CONFIG: ResolvedConfig = {
  configId: 'cfg-1',
  appId: 'app-1',
  provider: 'neon',
  poolMax: 3,
};

function setup(overrides: Partial<Parameters<typeof createConnectionResolver>[0]> = {}) {
  const adapter = createFakeAdapter();
  const loadConfig = vi.fn(async (appId: string) => (appId === 'app-1' ? CONFIG : null));
  const decrypt = vi.fn(() => 'postgresql://user:pw@ep-x.neon.tech/db?sslmode=require');
  const createAdapter = vi.fn(() => adapter);

  const resolver = createConnectionResolver({ loadConfig, decrypt, createAdapter, ...overrides });
  return { resolver, adapter, loadConfig, decrypt, createAdapter };
}

describe('createConnectionResolver', () => {
  it('builds an adapter on a cache miss and reuses it afterwards', async () => {
    const { resolver, adapter, loadConfig, decrypt } = setup();

    expect(await resolver.resolve('app-1')).toBe(adapter);
    expect(await resolver.resolve('app-1')).toBe(adapter);

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(resolver.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it('decrypts only on a miss — never for a cached app', async () => {
    const { resolver, decrypt } = setup();
    await resolver.resolve('app-1');
    await resolver.resolve('app-1');
    await resolver.resolve('app-1');
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it('passes the provider and pool size to the factory, and nothing else', async () => {
    const { resolver, createAdapter } = setup();
    await resolver.resolve('app-1');
    expect(createAdapter).toHaveBeenCalledWith({
      provider: 'neon',
      connectionString: 'postgresql://user:pw@ep-x.neon.tech/db?sslmode=require',
      poolMax: 3,
    });
  });

  it('collapses concurrent misses into one connection', async () => {
    const { resolver, createAdapter } = setup();
    const [a, b, c] = await Promise.all([
      resolver.resolve('app-1'),
      resolver.resolve('app-1'),
      resolver.resolve('app-1'),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(createAdapter).toHaveBeenCalledTimes(1);
  });

  it('throws DB_CONFIG_MISSING when the app has no database', async () => {
    const { resolver } = setup();
    await expect(resolver.resolve('app-unknown')).rejects.toThrowError(InfraError);
    await expect(resolver.resolve('app-unknown')).rejects.toMatchObject({ code: 'DB_CONFIG_MISSING' });
  });

  it('invalidate closes the adapter and forces a rebuild', async () => {
    const { resolver, adapter, loadConfig } = setup();
    await resolver.resolve('app-1');
    await resolver.invalidate('app-1');

    expect(adapter.closed()).toBe(true);
    await resolver.resolve('app-1');
    expect(loadConfig).toHaveBeenCalledTimes(2);
  });

  it('does not retain a failed build in the cache', async () => {
    const failing = vi.fn(() => {
      throw new Error('driver exploded');
    });
    const { resolver } = setup({ createAdapter: failing });
    await expect(resolver.resolve('app-1')).rejects.toThrowError(/driver exploded/);
    await expect(resolver.resolve('app-1')).rejects.toThrowError(/driver exploded/);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
