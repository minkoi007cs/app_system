/**
 * One round trip per check.
 *
 * The whole counter lives in a single upsert: insert a fresh window, or — if a row is already
 * there — either restart it (because the old window has passed) or increment it. Doing this as a
 * SELECT followed by an UPDATE would be two round trips *and* a race in which two concurrent
 * requests both read 99 and both write 100.
 *
 * The `returning` clause gives back the post-increment state, so the caller learns the verdict
 * without asking again.
 */
import { createHash } from 'node:crypto';
import { lt, sql } from 'drizzle-orm';
import type { MasterDatabase } from '../client.js';
import { infraRateLimits } from '../schema/rate-limits.js';

export const DEFAULT_LIMIT = 120;
export const WINDOW_MS = 60_000;

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

/** Hashed so the table holds no key id and no IP in readable form. */
export function rateLimitBucket(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

export async function consumeShared(
  db: MasterDatabase,
  identity: string,
  limit: number = DEFAULT_LIMIT,
  windowMs: number = WINDOW_MS,
  now: Date = new Date(),
): Promise<RateLimitVerdict> {
  const bucket = rateLimitBucket(identity);
  const windowEndsAt = new Date(now.getTime() + windowMs);

  const [row] = await db
    .insert(infraRateLimits)
    .values({ bucket, count: 1, windowEndsAt })
    .onConflictDoUpdate({
      target: infraRateLimits.bucket,
      set: {
        // Window passed → start a new one at 1. Still open → add one.
        count: sql`case when ${infraRateLimits.windowEndsAt} <= ${now} then 1 else ${infraRateLimits.count} + 1 end`,
        windowEndsAt: sql`case when ${infraRateLimits.windowEndsAt} <= ${now} then ${windowEndsAt} else ${infraRateLimits.windowEndsAt} end`,
      },
    })
    .returning();

  if (row === undefined) {
    // Fail open: a counter that cannot be written must not take the API down with it. The abuse
    // ceiling is a guard rail, not an authorisation check — those all fail closed elsewhere.
    return { allowed: true, remaining: limit, resetInMs: windowMs };
  }

  return {
    allowed: row.count <= limit,
    remaining: Math.max(limit - row.count, 0),
    resetInMs: Math.max(row.windowEndsAt.getTime() - now.getTime(), 0),
  };
}

/** Housekeeping: a window that closed carries no information. */
export async function sweepRateLimits(db: MasterDatabase, now: Date = new Date()): Promise<number> {
  const removed = await db
    .delete(infraRateLimits)
    .where(lt(infraRateLimits.windowEndsAt, now))
    .returning({ bucket: infraRateLimits.bucket });
  return removed.length;
}
