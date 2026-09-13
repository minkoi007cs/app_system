/**
 * One-shot WebAuthn challenges.
 *
 * A challenge must be random, single-use and short-lived: it is what stops a captured assertion
 * from being replayed. Storing it server-side (rather than in a cookie the client could swap)
 * keeps that guarantee even cross-domain.
 */
import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

export const WEBAUTHN_CHALLENGE_TTL_SECONDS = 300;

export const infraWebauthnChallenges = pgTable(
  'infra_webauthn_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 16 }).notNull().$type<'register' | 'authenticate'>(),
    challenge: text('challenge').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('infra_webauthn_user_idx').on(t.userId)],
);

export type InfraWebauthnChallengeRow = typeof infraWebauthnChallenges.$inferSelect;
