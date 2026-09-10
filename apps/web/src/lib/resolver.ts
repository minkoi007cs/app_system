/**
 * One connection resolver per process, wired to the Master DB.
 * Kept on globalThis so Next.js HMR does not open a new pool on every edit.
 */
import { createConnectionResolver, type ConnectionResolver } from '@infra/adapters';
import { getPrimaryDatabaseConfig, revealConnectionString } from '@infra/db';
import { db } from './db';

interface ResolverGlobal {
  __infraResolver?: ConnectionResolver;
}

const resolverGlobal = globalThis as unknown as ResolverGlobal;

export function resolver(): ConnectionResolver {
  resolverGlobal.__infraResolver ??= createConnectionResolver({
    async loadConfig(appId) {
      const row = await getPrimaryDatabaseConfig(db(), appId);
      if (row === null) return null;
      return {
        configId: row.id,
        appId: row.appId,
        provider: row.provider,
        poolMax: row.poolMax,
      };
    },
    // Decryption happens here and nowhere else on the request path.
    async decrypt(config) {
      const row = await getPrimaryDatabaseConfig(db(), config.appId);
      if (row === null) throw new Error('database config disappeared mid-resolve');
      return revealConnectionString(row);
    },
  });

  return resolverGlobal.__infraResolver;
}
