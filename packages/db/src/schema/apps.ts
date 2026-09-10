/** Registry of child applications served by the platform. */
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const APP_STATUSES = ['active', 'suspended', 'archived'] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

export const infraApps = pgTable(
  'infra_apps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** URL-safe identifier, e.g. 'learning-ai' */
    slug: varchar('slug', { length: 63 }).notNull().unique(),
    name: varchar('name', { length: 128 }).notNull(),
    description: text('description'),
    /** Better Auth user.id of the platform admin who owns this app. */
    ownerUserId: text('owner_user_id').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('active').$type<AppStatus>(),
    /** Browser origins allowed to hit /api/auth/* for this app. */
    allowedOrigins: jsonb('allowed_origins').$type<string[]>().notNull().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('infra_apps_owner_idx').on(t.ownerUserId), index('infra_apps_status_idx').on(t.status)],
);

export type InfraAppRow = typeof infraApps.$inferSelect;
export type NewInfraApp = typeof infraApps.$inferInsert;
