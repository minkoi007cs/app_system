/** API keys issued to child applications. Only the SHA-256 hash is ever stored. */
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { infraApps } from './apps.js';

export type ApiKeyScope = 'db:read' | 'db:write' | 'auth:read' | 'admin';
export type ApiKeyKind = 'publishable' | 'secret';

export const infraApiKeys = pgTable(
  'infra_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => infraApps.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 128 }).notNull(),
    /** sha256(rawKey) as 64 hex characters. The raw key is shown once and never persisted. */
    keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
    /** Display-only prefix, e.g. 'pk_live_a1B2c3D4'. */
    keyPrefix: varchar('key_prefix', { length: 20 }).notNull(),
    environment: varchar('environment', { length: 8 }).notNull().default('live').$type<'live' | 'test'>(),
    /**
     * 'secret' (sk_) may do anything; 'publishable' (pk_) is safe to ship in a browser bundle and
     * is refused by every endpoint that bypasses the rules engine. Existing rows default to
     * 'secret' because that is the power the old pk_live_ keys actually had.
     */
    keyType: varchar('key_type', { length: 16 }).notNull().default('secret').$type<ApiKeyKind>(),
    scopes: jsonb('scopes').$type<ApiKeyScope[]>().notNull().default(['db:read']),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('infra_api_keys_app_idx').on(t.appId), index('infra_api_keys_hash_idx').on(t.keyHash)],
);

export type InfraApiKeyRow = typeof infraApiKeys.$inferSelect;
export type NewInfraApiKey = typeof infraApiKeys.$inferInsert;
