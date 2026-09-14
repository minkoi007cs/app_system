/**
 * Impersonation sessions.
 *
 * Support needs to see what a user sees. That is a real need and a real hazard: it is the one
 * feature that lets a platform admin act as somebody else, and if it is not built carefully it is
 * indistinguishable from account takeover — by design, which is what makes it dangerous.
 *
 * Four constraints are structural rather than procedural, so they cannot be skipped in a hurry:
 *
 *   - `reason` is NOT NULL. There is no code path that starts one without a stated reason.
 *   - `expires_at` is NOT NULL. Every session dies on its own; forgetting to end one is not an
 *     option the schema allows.
 *   - `ended_at` / `ended_reason` record how it finished, so "expired" and "ended deliberately"
 *     are distinguishable afterwards.
 *   - `read_only` defaults to true. Looking is the common case; acting is the exception that has
 *     to be asked for.
 *
 * Everything done during one of these is auditable back to the real person, because tokens minted
 * while it is active carry the `act` claim (see jwt.ts) — the audit trail never shows only the
 * impersonated user.
 */
import { boolean, index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { infraApps } from './apps.js';
import { user } from './auth.js';

export const IMPERSONATION_END_REASONS = ['ended', 'expired', 'revoked'] as const;
export type ImpersonationEndReason = (typeof IMPERSONATION_END_REASONS)[number];

/** Hard ceiling. A support session that needs longer should be started again, with a new reason. */
export const MAX_IMPERSONATION_MINUTES = 60;
export const MIN_REASON_LENGTH = 12;

export const infraImpersonationSessions = pgTable(
  'infra_impersonation_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The real person. Never null, never the impersonated user. */
    actorAdminId: text('actor_admin_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    targetUserId: text('target_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    appId: uuid('app_id').references(() => infraApps.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    /** Optional link to a support ticket, so the reason can be checked against something. */
    ticketRef: varchar('ticket_ref', { length: 128 }),
    readOnly: boolean('read_only').notNull().default(true),
    ipAddress: varchar('ip_address', { length: 45 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedReason: varchar('ended_reason', { length: 16 }).$type<ImpersonationEndReason>(),
  },
  (t) => [
    index('infra_impersonation_actor_idx').on(t.actorAdminId, t.startedAt),
    index('infra_impersonation_target_idx').on(t.targetUserId, t.startedAt),
    index('infra_impersonation_active_idx').on(t.endedAt, t.expiresAt),
  ],
);

export type InfraImpersonationRow = typeof infraImpersonationSessions.$inferSelect;
