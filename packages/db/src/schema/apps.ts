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
    /**
     * Role granted automatically when somebody joins this app. `null` turns that off.
     *
     * Two product shapes, one column. A B2C app wants a person who signs up to be able to use it
     * immediately — without this they hold a valid token, are a member of the app, and can do
     * nothing, which reads from the outside as the product being broken. A B2B app wants the
     * opposite: access arrives by invitation, and an account that appears on its own gets nothing
     * until somebody grants it. Setting this to `null` is how you say so.
     *
     * The default is `'member'` because the common case should not require configuration. What it
     * grants is still entirely up to the role: RBAC decides *which operations*, ABAC decides
     * *which rows*. A default role holding wildcard permissions would hand those to every signup,
     * so `setDefaultRole` refuses one.
     */
    defaultRoleKey: varchar('default_role_key', { length: 64 }).default('member'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('infra_apps_owner_idx').on(t.ownerUserId), index('infra_apps_status_idx').on(t.status)],
);

export type InfraAppRow = typeof infraApps.$inferSelect;
export type NewInfraApp = typeof infraApps.$inferInsert;
