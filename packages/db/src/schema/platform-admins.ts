/**
 * Platform administrators — the people who can reach every app's encrypted credentials.
 *
 * Membership here is only ONE of three independent conditions (see docs/iam-blueprint.md §0.1):
 * the email must also be in INFRA_SUPER_ADMIN_EMAILS, and the session must have passed MFA.
 * A single bug in any one layer must not be enough to hand someone the platform.
 */
import { pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

export const PLATFORM_ADMIN_ROLES = ['super_admin', 'support', 'auditor'] as const;
export type PlatformAdminRole = (typeof PLATFORM_ADMIN_ROLES)[number];

export const infraPlatformAdmins = pgTable('infra_platform_admins', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 24 }).notNull().default('super_admin').$type<PlatformAdminRole>(),
  status: varchar('status', { length: 16 }).notNull().default('active'),
  /** When MFA became mandatory for this admin — set the moment the row is created. */
  mfaRequiredSince: timestamp('mfa_required_since', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type InfraPlatformAdminRow = typeof infraPlatformAdmins.$inferSelect;
