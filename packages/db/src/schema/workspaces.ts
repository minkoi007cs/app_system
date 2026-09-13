/**
 * Workspaces — the "extensible 2-tier" shape.
 *
 * During personal use nothing references these tables and every `workspace_id` is null. When an
 * app grows a team feature, the same rows gain a workspace without a migration that rewrites data:
 * that is the whole point of keeping the column nullable from day one.
 */
import { index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { infraApps } from './apps.js';
import { user } from './auth.js';

export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const infraWorkspaces = pgTable(
  'infra_workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => infraApps.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 63 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('infra_ws_app_slug_idx').on(t.appId, t.slug)],
);

export const infraWorkspaceMembers = pgTable(
  'infra_workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => infraWorkspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull().default('member').$type<WorkspaceRole>(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('infra_ws_members_user_idx').on(t.userId),
  ],
);

export type InfraWorkspaceRow = typeof infraWorkspaces.$inferSelect;
export type InfraWorkspaceMemberRow = typeof infraWorkspaceMembers.$inferSelect;
