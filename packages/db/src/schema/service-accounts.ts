/**
 * Machine identities: CI, cron jobs, AI agents, a child app's own backend.
 *
 * Every service account has a human owner. A credential nobody is responsible for is the one
 * still working two years after the person who made it left.
 */
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { infraApps } from './apps.js';

export const infraServiceAccounts = pgTable(
  'infra_service_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => infraApps.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 96 }).notNull(),
    description: text('description'),
    /** Who answers for this identity. */
    ownerUserId: text('owner_user_id').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    /** Exact IPs or IPv4 CIDR ranges. Empty means unrestricted. */
    ipAllowlist: jsonb('ip_allowlist').$type<string[]>().notNull().default([]),
    /** Scopes any token minted for this account may carry. */
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('infra_service_accounts_app_idx').on(t.appId)],
);

export type InfraServiceAccountRow = typeof infraServiceAccounts.$inferSelect;
