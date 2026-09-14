/**
 * Append-only audit trail.
 * Never records: raw API keys, connection strings, query parameter values.
 */
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { infraApps } from './apps.js';

export const AUDIT_ACTIONS = [
  'app.created',
  'app.updated',
  'app.suspended',
  'app.archived',
  'key.issued',
  'key.rotated',
  'key.revoked',
  'db.config.created',
  'db.config.updated',
  'db.config.deleted',
  'db.query.executed',
  'auth.signin',
  'auth.signout',
  'auth.token.issued',
  'auth.token.refreshed',
  'auth.token.revoked',
  'auth.token.reuse_detected',
  'auth.signin.failed',
  'auth.signin.throttled',
  'auth.password.rejected',
  'auth.recovery.requested',
  'auth.recovery.completed',
  'auth.recovery.failed',
  'access.granted',
  'access.denied',
  'role.assigned',
  'role.revoked',
  'policy.created',
  'policy.updated',
  'policy.deleted',
  'user.invited',
  'user.joined',
  'user.suspended',
  'user.reinstated',
  'user.offboarded',
  'user.transferred',
  'service_account.created',
  'service_account.revoked',
  'health.check',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditActorType = 'admin' | 'api_key' | 'system';
export type AuditOutcome = 'success' | 'failure';

export const infraAuditLogs = pgTable(
  'infra_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id').references(() => infraApps.id, { onDelete: 'set null' }),
    actorType: varchar('actor_type', { length: 16 }).notNull().$type<AuditActorType>(),
    actorId: text('actor_id'),
    action: varchar('action', { length: 64 }).notNull().$type<AuditAction>(),
    targetType: varchar('target_type', { length: 32 }),
    targetId: text('target_id'),
    outcome: varchar('outcome', { length: 16 }).notNull().default('success').$type<AuditOutcome>(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    /** Shape only: { sqlHash, rowCount, durationMs, … } */
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('infra_audit_app_time_idx').on(t.appId, t.createdAt),
    index('infra_audit_action_idx').on(t.action),
  ],
);

export type InfraAuditLogRow = typeof infraAuditLogs.$inferSelect;
export type NewInfraAuditLog = typeof infraAuditLogs.$inferInsert;
