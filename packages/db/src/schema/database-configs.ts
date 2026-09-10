/**
 * Per-app tenant database configuration.
 * The connection string is stored ONLY as an AES-256-GCM envelope (see @infra/core/crypto).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  text,
} from 'drizzle-orm/pg-core';
import { infraApps } from './apps.js';

export const DB_PROVIDERS = ['neon', 'supabase', 'turso'] as const;
export type DbProvider = (typeof DB_PROVIDERS)[number];

export const SQL_DIALECTS = ['postgres', 'libsql'] as const;
export type SqlDialect = (typeof SQL_DIALECTS)[number];

export const HEALTH_STATUSES = ['healthy', 'degraded', 'down', 'unknown'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const infraDatabaseConfigs = pgTable(
  'infra_database_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => infraApps.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 16 }).notNull().$type<DbProvider>(),
    dialect: varchar('dialect', { length: 16 }).notNull().$type<SqlDialect>(),
    label: varchar('label', { length: 128 }).notNull(),
    isPrimary: boolean('is_primary').notNull().default(true),

    // ── AES-256-GCM envelope ────────────────────────────────────────────────
    encryptedConnectionString: text('encrypted_connection_string').notNull(),
    encryptionIv: varchar('encryption_iv', { length: 24 }).notNull(),
    encryptionAuthTag: varchar('encryption_auth_tag', { length: 32 }).notNull(),
    encryptionKeyVersion: integer('encryption_key_version').notNull().default(1),

    /** Display/diagnostics only — never enough to connect. */
    hostHint: varchar('host_hint', { length: 255 }),
    poolMax: integer('pool_max').notNull().default(3),

    healthStatus: varchar('health_status', { length: 16 }).notNull().default('unknown').$type<HealthStatus>(),
    healthLatencyMs: integer('health_latency_ms'),
    healthCheckedAt: timestamp('health_checked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('infra_db_configs_app_idx').on(t.appId),
    uniqueIndex('infra_db_configs_one_primary')
      .on(t.appId)
      .where(sql`${t.isPrimary} = true`),
  ],
);

export type InfraDatabaseConfigRow = typeof infraDatabaseConfigs.$inferSelect;
export type NewInfraDatabaseConfig = typeof infraDatabaseConfigs.$inferInsert;
