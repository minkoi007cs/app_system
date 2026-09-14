/**
 * Rate-limit counters, shared across instances.
 *
 * The in-process limiter this replaces was correct for exactly one deployment shape: a single
 * self-hosted instance (ADR-011). On serverless the same code silently multiplies every limit by
 * the number of instances, and the failure is invisible — nothing errors, the ceiling is just
 * quietly higher than the number written in the config. That is the worst kind of security bug:
 * one that looks like it is working.
 *
 * A fixed window rather than a sliding one, on purpose. A sliding window needs either a row per
 * request or a sorted-set structure Postgres does not give cheaply, and a fixed window's known
 * weakness — up to 2× the limit across a boundary — is acceptable for an abuse ceiling. It would
 * not be acceptable for the sign-in throttle, which is why that one has its own table with its own
 * curve rather than reusing this.
 */
import { bigint, index, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

export const infraRateLimits = pgTable(
  'infra_rate_limits',
  {
    /** sha256 of the caller identity — an api key id, an ip. Never the identity itself. */
    bucket: varchar('bucket', { length: 64 }).primaryKey(),
    count: bigint('count', { mode: 'number' }).notNull().default(0),
    /** When the current window ends. A row whose window has passed is treated as absent. */
    windowEndsAt: timestamp('window_ends_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('infra_rate_limits_window_idx').on(t.windowEndsAt)],
);

export type InfraRateLimitRow = typeof infraRateLimits.$inferSelect;
