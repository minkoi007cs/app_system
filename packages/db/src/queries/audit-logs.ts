import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { MasterDatabase } from '../client.js';
import {
  infraAuditLogs,
  type AuditAction,
  type AuditActorType,
  type AuditOutcome,
  type InfraAuditLogRow,
} from '../schema/audit-logs.js';

export interface AuditInput {
  appId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: AuditOutcome;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Shape only — ids, counts, durations. Never values, secrets or SQL parameters. */
  meta?: Record<string, unknown>;
}

/** Fingerprint of a SQL statement, so queries can be grouped without storing the text. */
export function sqlFingerprint(sql: string): string {
  return createHash('sha256').update(sql.trim().replace(/\s+/g, ' '), 'utf8').digest('hex').slice(0, 16);
}

export async function recordAudit(db: MasterDatabase, input: AuditInput): Promise<void> {
  await db.insert(infraAuditLogs).values({
    appId: input.appId ?? null,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    outcome: input.outcome ?? 'success',
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    meta: input.meta ?? {},
  });
}

/** Fire-and-forget variant for hot paths: auditing must never fail a request. */
export function recordAuditAsync(db: MasterDatabase, input: AuditInput): void {
  void recordAudit(db, input).catch(() => {
    /* auditing is best-effort */
  });
}

export interface ListAuditOptions {
  appId?: string;
  action?: AuditAction;
  limit?: number;
}

export async function listAuditLogs(
  db: MasterDatabase,
  options: ListAuditOptions = {},
): Promise<InfraAuditLogRow[]> {
  const filters = [];
  if (options.appId !== undefined) filters.push(eq(infraAuditLogs.appId, options.appId));
  if (options.action !== undefined) filters.push(eq(infraAuditLogs.action, options.action));

  const base = db.select().from(infraAuditLogs);
  const filtered = filters.length > 0 ? base.where(and(...filters)) : base;
  return filtered.orderBy(desc(infraAuditLogs.createdAt)).limit(options.limit ?? 100);
}
