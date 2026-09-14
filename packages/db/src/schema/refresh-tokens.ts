/**
 * Refresh tokens, stored as hashes and grouped into families.
 *
 * One login = one family. Each rotation appends a new row to that family and marks the previous
 * one used. If a used row is ever presented again, the family is compromised and every row in it
 * — plus the session behind it — is revoked.
 */
import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { infraApps } from './apps.js';
import { user } from './auth.js';

export const REFRESH_REVOKE_REASONS = [
  'rotated',
  'reuse_detected',
  'logout',
  'offboard',
  'expired',
  'password_reset',
] as const;
export type RefreshRevokeReason = (typeof REFRESH_REVOKE_REASONS)[number];

export const infraRefreshTokens = pgTable(
  'infra_refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** sha256 of the raw token. The raw value is never stored. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    familyId: uuid('family_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    appId: uuid('app_id')
      .notNull()
      .references(() => infraApps.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),

    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: varchar('revoked_reason', { length: 24 }).$type<RefreshRevokeReason>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('infra_rt_family_idx').on(t.familyId),
    index('infra_rt_user_app_idx').on(t.userId, t.appId),
    index('infra_rt_session_idx').on(t.sessionId),
  ],
);

export type InfraRefreshTokenRow = typeof infraRefreshTokens.$inferSelect;
export type NewInfraRefreshToken = typeof infraRefreshTokens.$inferInsert;
