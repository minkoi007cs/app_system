/**
 * appId → live DatabaseAdapter.
 *
 * The plaintext connection string exists only inside resolve(), for the moment it takes
 * to construct a driver. It is never cached, logged or returned.
 */
import { InfraError } from '@infra/core';
import { createAdapter } from './factory.js';
import { createAdapterPool, type AdapterPool, type AdapterPoolOptions, type PoolStats } from './pool.js';
import type { DatabaseAdapter, DbProvider } from './types.js';

export interface ResolvedConfig {
  configId: string;
  appId: string;
  provider: DbProvider;
  poolMax?: number;
}

export interface ResolverDeps {
  /** Loads the primary database config row for an app, or null when none is set. */
  loadConfig: (appId: string) => Promise<ResolvedConfig | null>;
  /** Decrypts that row's connection string. Called at most once per cache miss. */
  decrypt: (config: ResolvedConfig) => Promise<string> | string;
  /** Lets a caller swap in a fake adapter in tests. */
  createAdapter?: typeof createAdapter;
  pool?: AdapterPool;
  poolOptions?: AdapterPoolOptions;
}

export interface ConnectionResolver {
  resolve(appId: string): Promise<DatabaseAdapter>;
  /** Call whenever an admin edits or deletes a database config. */
  invalidate(appId: string): Promise<void>;
  closeAll(): Promise<void>;
  stats(): PoolStats;
}

export function createConnectionResolver(deps: ResolverDeps): ConnectionResolver {
  const pool = deps.pool ?? createAdapterPool(deps.poolOptions ?? {});
  const build = deps.createAdapter ?? createAdapter;
  const inFlight = new Map<string, Promise<DatabaseAdapter>>();

  async function build_(appId: string): Promise<DatabaseAdapter> {
    const config = await deps.loadConfig(appId);
    if (config === null) {
      throw new InfraError('DB_CONFIG_MISSING', 'no primary database configured for this app', {
        details: { appId },
      });
    }

    const connectionString = await deps.decrypt(config);
    const adapter = build({
      provider: config.provider,
      connectionString,
      ...(config.poolMax === undefined ? {} : { poolMax: config.poolMax }),
    });

    await pool.set(appId, adapter);
    return adapter;
  }

  return {
    async resolve(appId: string): Promise<DatabaseAdapter> {
      const cached = pool.get(appId);
      if (cached !== null) return cached;

      // Collapse concurrent misses so a cold app opens exactly one connection.
      const pending = inFlight.get(appId);
      if (pending !== undefined) return pending;

      const promise = build_(appId).finally(() => {
        inFlight.delete(appId);
      });
      inFlight.set(appId, promise);
      return promise;
    },

    async invalidate(appId: string): Promise<void> {
      await pool.invalidate(appId);
    },

    async closeAll(): Promise<void> {
      await pool.clear();
    },

    stats(): PoolStats {
      return pool.stats();
    },
  };
}
