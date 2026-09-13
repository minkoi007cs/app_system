/**
 * User lifecycle: join → transfer → leave.
 *
 * Better Auth owns the `user` table, so status lives alongside it rather than inside it. That also
 * keeps the audit-relevant columns (who suspended whom, when, why) out of a table a library
 * migrates.
 */
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { infraApps } from './apps.js';
import { user } from './auth.js';

export const USER_STATUSES = ['active', 'suspended', 'offboarded', 'pending_deletion'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const infraUserLifecycle = pgTable('infra_user_lifecycle', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 24 }).notNull().default('active').$type<UserStatus>(),
  reason: text('reason'),
  changedBy: text('changed_by'),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  offboardedAt: timestamp('offboarded_at', { withTimezone: true }),
  /** Set when a deletion is requested; a job purges after the grace period. */
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const infraInvitations = pgTable(
  'infra_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => infraApps.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    role: varchar('role', { length: 16 }).notNull().default('member'),
    /** sha256 of the token in the invite link. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    invitedBy: text('invited_by').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: text('accepted_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('infra_invitations_app_idx').on(t.appId),
    uniqueIndex('infra_invitations_hash_idx').on(t.tokenHash),
  ],
);

export type InfraUserLifecycleRow = typeof infraUserLifecycle.$inferSelect;
export type InfraInvitationRow = typeof infraInvitations.$inferSelect;
