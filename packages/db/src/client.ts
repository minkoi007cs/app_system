/**
 * Master DB client (Neon PostgreSQL via postgres-js).
 * A single pool per process, kept on globalThis so Next.js HMR does not leak connections.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { InfraError } from '@infra/core';
import * as schema from './schema/index.js';

export type MasterDatabase = PostgresJsDatabase<typeof schema>;

export interface MasterDbOptions {
  /** Free tiers hand out very few connection slots — keep this small. */
  max?: number;
  idleTimeoutSeconds?: number;
  connectTimeoutSeconds?: number;
}

interface DbGlobal {
  __infraMasterSql?: postgres.Sql;
  __infraMasterDb?: MasterDatabase;
}

const dbGlobal = globalThis as unknown as DbGlobal;

export function createMasterDb(connectionString: string, options: MasterDbOptions = {}): MasterDatabase {
  const sql = postgres(connectionString, {
    max: options.max ?? 5,
    idle_timeout: options.idleTimeoutSeconds ?? 30,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    prepare: false,
  });
  return drizzle(sql, { schema });
}

/** Process-wide singleton. Throws early when INFRA_MASTER_DATABASE_URL is missing. */
export function masterDb(env: NodeJS.ProcessEnv = process.env): MasterDatabase {
  if (dbGlobal.__infraMasterDb !== undefined) return dbGlobal.__infraMasterDb;

  const connectionString = env['INFRA_MASTER_DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new InfraError('CONFIG_INVALID', 'INFRA_MASTER_DATABASE_URL is not set');
  }

  const sql = postgres(connectionString, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  });
  const db = drizzle(sql, { schema });

  dbGlobal.__infraMasterSql = sql;
  dbGlobal.__infraMasterDb = db;
  return db;
}

export async function closeMasterDb(): Promise<void> {
  const sql = dbGlobal.__infraMasterSql;
  if (sql !== undefined) await sql.end({ timeout: 5 });
  delete dbGlobal.__infraMasterSql;
  delete dbGlobal.__infraMasterDb;
}

export { schema };
