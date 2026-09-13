/** Dashboard session helpers — step-up state lives on the session row itself. */
import { eq } from 'drizzle-orm';
import type { MasterDatabase } from '../client.js';
import { session, type SessionRow } from '../schema/auth.js';

export async function getSessionById(db: MasterDatabase, sessionId: string): Promise<SessionRow | null> {
  const [row] = await db.select().from(session).where(eq(session.id, sessionId)).limit(1);
  return row ?? null;
}

/** Records that this session cleared an MFA challenge. */
export async function markSessionMfaVerified(
  db: MasterDatabase,
  sessionId: string,
  at: Date = new Date(),
): Promise<void> {
  await db.update(session).set({ mfaVerifiedAt: at, updatedAt: at }).where(eq(session.id, sessionId));
}

/** A step-up is valid only for a while; after that the admin is challenged again. */
export function mfaStillFresh(verifiedAt: Date | null, maxAgeHours = 8, now: Date = new Date()): boolean {
  if (verifiedAt === null) return false;
  return now.getTime() - verifiedAt.getTime() < maxAgeHours * 60 * 60 * 1000;
}

export async function listUserSessions(db: MasterDatabase, userId: string): Promise<SessionRow[]> {
  return db.select().from(session).where(eq(session.userId, userId));
}
