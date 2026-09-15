/**
 * Starting, reading and ending an impersonation session.
 *
 * The refusals here are the feature. Anyone can write "become this user"; what makes it safe to
 * ship is that it refuses to become a platform admin, refuses without a reason worth reading,
 * refuses to run longer than an hour, and refuses to start a second one while the first is open.
 */
import { and, desc, eq, gt, isNull, lte } from 'drizzle-orm';
import { InfraError } from '@infra/core';
import type { MasterDatabase } from '../client.js';
import {
  infraImpersonationSessions,
  MAX_IMPERSONATION_MINUTES,
  MIN_REASON_LENGTH,
  type ImpersonationEndReason,
  type InfraImpersonationRow,
} from '../schema/impersonation.js';
import { infraPlatformAdmins } from '../schema/platform-admins.js';

export interface StartImpersonationInput {
  actorAdminId: string;
  targetUserId: string;
  reason: string;
  appId?: string | null;
  ticketRef?: string | null;
  minutes?: number;
  readOnly?: boolean;
  ipAddress?: string | null;
}

export async function startImpersonation(
  db: MasterDatabase,
  input: StartImpersonationInput,
  now: Date = new Date(),
): Promise<InfraImpersonationRow> {
  const reason = input.reason.trim();

  // A reason nobody can act on is the same as no reason; the length floor makes "test" fail.
  if (reason.length < MIN_REASON_LENGTH) {
    throw new InfraError('VALIDATION_FAILED', `reason must be at least ${MIN_REASON_LENGTH} characters`);
  }

  // Impersonating yourself is pointless; impersonating another admin is a lateral move into a
  // second admin's authority with only your own credential — the escalation path this must not have.
  if (input.actorAdminId === input.targetUserId) {
    throw new InfraError('VALIDATION_FAILED', 'cannot impersonate yourself');
  }

  const [targetIsAdmin] = await db
    .select({ userId: infraPlatformAdmins.userId })
    .from(infraPlatformAdmins)
    .where(
      and(eq(infraPlatformAdmins.userId, input.targetUserId), eq(infraPlatformAdmins.status, 'active')),
    )
    .limit(1);

  if (targetIsAdmin !== undefined) {
    throw new InfraError('FORBIDDEN_SCOPE', 'platform admins cannot be impersonated');
  }

  // One at a time: two open sessions make the audit trail ambiguous about which one an action
  // belonged to, and that ambiguity is the whole value of the record.
  const existing = await activeImpersonation(db, input.actorAdminId, now);
  if (existing !== null) {
    throw new InfraError('VALIDATION_FAILED', 'end the current impersonation session first', {
      details: { sessionId: existing.id },
    });
  }

  const minutes = Math.min(input.minutes ?? 15, MAX_IMPERSONATION_MINUTES);
  const [row] = await db
    .insert(infraImpersonationSessions)
    .values({
      actorAdminId: input.actorAdminId,
      targetUserId: input.targetUserId,
      appId: input.appId ?? null,
      reason,
      ticketRef: input.ticketRef ?? null,
      readOnly: input.readOnly ?? true,
      ipAddress: input.ipAddress ?? null,
      startedAt: now,
      expiresAt: new Date(now.getTime() + minutes * 60_000),
    })
    .returning();

  if (row === undefined) throw new InfraError('INTERNAL', 'impersonation insert returned no row');
  return row;
}

/** The admin's live session, if any. Expiry is evaluated in SQL so a stale row never reads active. */
export async function activeImpersonation(
  db: MasterDatabase,
  actorAdminId: string,
  now: Date = new Date(),
): Promise<InfraImpersonationRow | null> {
  const [row] = await db
    .select()
    .from(infraImpersonationSessions)
    .where(
      and(
        eq(infraImpersonationSessions.actorAdminId, actorAdminId),
        isNull(infraImpersonationSessions.endedAt),
        gt(infraImpersonationSessions.expiresAt, now),
      ),
    )
    .orderBy(desc(infraImpersonationSessions.startedAt))
    .limit(1);

  return row ?? null;
}

export async function endImpersonation(
  db: MasterDatabase,
  sessionId: string,
  reason: ImpersonationEndReason = 'ended',
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(infraImpersonationSessions)
    .set({ endedAt: now, endedReason: reason })
    .where(and(eq(infraImpersonationSessions.id, sessionId), isNull(infraImpersonationSessions.endedAt)));
}

/** Housekeeping: closes sessions that ran out rather than leaving them looking open forever. */
export async function expireImpersonations(db: MasterDatabase, now: Date = new Date()): Promise<number> {
  const closed = await db
    .update(infraImpersonationSessions)
    .set({ endedAt: now, endedReason: 'expired' })
    .where(
      and(
        isNull(infraImpersonationSessions.endedAt),
        // `lte`, not a raw sql template: inside a template the Date loses the column's type mapper
        // and reaches Postgres as `Mon Sep 14 2026 …`, which it cannot parse as a timestamptz. The
        // statement threw on every run, so this sweep never closed a single expired session —
        // exactly the failure this file's header warns about.
        lte(infraImpersonationSessions.expiresAt, now),
      ),
    )
    .returning({ id: infraImpersonationSessions.id });

  return closed.length;
}

export async function listImpersonations(
  db: MasterDatabase,
  limit = 50,
): Promise<InfraImpersonationRow[]> {
  return db
    .select()
    .from(infraImpersonationSessions)
    .orderBy(desc(infraImpersonationSessions.startedAt))
    .limit(limit);
}

/** Everything the target should be able to see about having been impersonated. */
export async function impersonationsOfUser(
  db: MasterDatabase,
  targetUserId: string,
  limit = 20,
): Promise<InfraImpersonationRow[]> {
  return db
    .select()
    .from(infraImpersonationSessions)
    .where(eq(infraImpersonationSessions.targetUserId, targetUserId))
    .orderBy(desc(infraImpersonationSessions.startedAt))
    .limit(limit);
}
