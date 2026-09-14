/**
 * Sign-in defence: failure counters and account-recovery tokens.
 *
 * Neither table stores an email address or an IP in the clear. Counters are keyed by a SHA-256 of
 * the scope key, so a dump of `infra_login_attempts` cannot be replayed into a list of who has an
 * account here — which is exactly what a table of "failed logins for alice@example.com" would be.
 */
import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  text,
} from 'drizzle-orm/pg-core';
import type { LoginScope } from '@infra/core';
import { user } from './auth.js';

export const infraLoginAttempts = pgTable(
  'infra_login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'ip' or 'ip_email' — see IP_POLICY / IP_EMAIL_POLICY in @infra/core. */
    scope: varchar('scope', { length: 16 }).notNull().$type<LoginScope>(),
    /** sha256(scope key). Never the address itself. */
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    failureCount: integer('failure_count').notNull().default(0),
    firstFailureAt: timestamp('first_failure_at', { withTimezone: true }).notNull().defaultNow(),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null means "counting, not locked". */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('infra_login_attempts_key_idx').on(t.scope, t.keyHash),
    index('infra_login_attempts_last_idx').on(t.lastFailureAt),
  ],
);

export const RECOVERY_PURPOSES = ['password_reset'] as const;
export type RecoveryPurpose = (typeof RECOVERY_PURPOSES)[number];

export const infraRecoveryTokens = pgTable(
  'infra_recovery_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 24 }).notNull().default('password_reset').$type<RecoveryPurpose>(),
    /** sha256 of the token in the link. The raw value is never stored. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set by the atomic burn; a second redemption finds it non-null and loses. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** Kept so an abnormal reset shows up in the audit trail with somewhere to point. */
    requestedIp: varchar('requested_ip', { length: 45 }),
    consumedIp: varchar('consumed_ip', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('infra_recovery_hash_idx').on(t.tokenHash),
    index('infra_recovery_user_idx').on(t.userId),
    index('infra_recovery_expiry_idx').on(t.expiresAt),
  ],
);

export type InfraLoginAttemptRow = typeof infraLoginAttempts.$inferSelect;
export type InfraRecoveryTokenRow = typeof infraRecoveryTokens.$inferSelect;
