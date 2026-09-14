/**
 * Brute-force policy for the sign-in endpoint.
 *
 * Pure decision logic: the caller supplies the counters, this decides whether an attempt is allowed
 * and for how long it is not. Keeping it pure is what makes the lockout curve testable without a
 * database and without waiting real seconds.
 *
 * Three things it deliberately does NOT do:
 *
 *   - It never locks an account permanently. A permanent lock turns a throttle into a denial of
 *     service anyone can aim at anyone else by guessing wrong on purpose. The curve caps and the
 *     counter decays.
 *   - It never distinguishes "no such account" from "wrong password". That distinction is a free
 *     user-enumeration oracle, and it leaks through timing as readily as through status codes —
 *     hence `remainingFloorMs`, which pads every answer out to the same duration.
 *   - It never throttles on email alone. Locking an account by its address alone lets an attacker
 *     lock a known victim out from anywhere. Counters are keyed by IP, and by (IP, email) together.
 */
import { createHash, randomInt } from 'node:crypto';

export const LOGIN_SCOPES = ['ip', 'ip_email'] as const;
export type LoginScope = (typeof LOGIN_SCOPES)[number];

export interface ThrottlePolicy {
  /** Failures before any lockout applies — typos must not cost anything. */
  freeAttempts: number;
  /** Lockout for the first failure past the free ones; doubles from there. */
  baseLockoutMs: number;
  maxLockoutMs: number;
  /** A counter this stale is treated as zero: yesterday's typos are not evidence. */
  counterTtlMs: number;
}

/** Targeted guessing at one account: tight, because a real person rarely gets past five. */
export const IP_EMAIL_POLICY: ThrottlePolicy = {
  freeAttempts: 5,
  baseLockoutMs: 30_000,
  maxLockoutMs: 15 * 60_000,
  counterTtlMs: 60 * 60_000,
};

/** Credential stuffing from one source across many accounts: looser count, longer ceiling. */
export const IP_POLICY: ThrottlePolicy = {
  freeAttempts: 20,
  baseLockoutMs: 60_000,
  maxLockoutMs: 60 * 60_000,
  counterTtlMs: 60 * 60_000,
};

export const POLICY_FOR: Readonly<Record<LoginScope, ThrottlePolicy>> = {
  ip: IP_POLICY,
  ip_email: IP_EMAIL_POLICY,
};

export interface AttemptState {
  failureCount: number;
  lastFailureAt: Date | null;
  lockedUntil: Date | null;
}

export const EMPTY_ATTEMPT: AttemptState = { failureCount: 0, lastFailureAt: null, lockedUntil: null };

export interface ThrottleVerdict {
  allowed: boolean;
  /** 0 when allowed. Feeds the Retry-After header. */
  retryAfterMs: number;
  /** Counter as it stands after decay — what the next failure increments. */
  failureCount: number;
}

/** How long a lockout lasts after `failureCount` failures. 0 means "not locked out at all". */
export function lockoutFor(failureCount: number, policy: ThrottlePolicy): number {
  const over = failureCount - policy.freeAttempts;
  if (over <= 0) return 0;
  // 2^30 ms is ~12 days; capping the exponent first keeps the doubling away from Infinity.
  const doublings = Math.min(over - 1, 30);
  return Math.min(policy.baseLockoutMs * 2 ** doublings, policy.maxLockoutMs);
}

/** Drops a counter that has gone quiet for longer than the policy's TTL. */
export function decay(state: AttemptState, policy: ThrottlePolicy, now: Date = new Date()): AttemptState {
  if (state.lastFailureAt === null) return EMPTY_ATTEMPT;
  if (now.getTime() - state.lastFailureAt.getTime() < policy.counterTtlMs) return state;
  return EMPTY_ATTEMPT;
}

export function evaluateAttempt(
  state: AttemptState,
  policy: ThrottlePolicy,
  now: Date = new Date(),
): ThrottleVerdict {
  const current = decay(state, policy, now);

  if (current.lockedUntil !== null && current.lockedUntil.getTime() > now.getTime()) {
    return {
      allowed: false,
      retryAfterMs: current.lockedUntil.getTime() - now.getTime(),
      failureCount: current.failureCount,
    };
  }

  return { allowed: true, retryAfterMs: 0, failureCount: current.failureCount };
}

/** The counter row as it should look after one more failure. */
export function afterFailure(
  state: AttemptState,
  policy: ThrottlePolicy,
  now: Date = new Date(),
): AttemptState {
  const current = decay(state, policy, now);
  const failureCount = current.failureCount + 1;
  const lockoutMs = lockoutFor(failureCount, policy);

  return {
    failureCount,
    lastFailureAt: now,
    lockedUntil: lockoutMs === 0 ? null : new Date(now.getTime() + lockoutMs),
  };
}

/** Picks the stricter of several verdicts — any scope saying no is enough to refuse. */
export function strictest(verdicts: readonly ThrottleVerdict[]): ThrottleVerdict {
  const failureCount = verdicts.reduce((max, v) => Math.max(max, v.failureCount), 0);
  const denied = verdicts.filter((v) => !v.allowed);
  if (denied.length === 0) return { allowed: true, retryAfterMs: 0, failureCount };

  const retryAfterMs = denied.reduce((max, v) => Math.max(max, v.retryAfterMs), 0);
  return { allowed: false, retryAfterMs, failureCount };
}

// ── timing ───────────────────────────────────────────────────────────────────

/** Every sign-in answer takes at least this long, whatever the outcome. */
export const RESPONSE_FLOOR_MS = 350;
/** Random padding on top, so an observer cannot subtract a known constant. */
export const RESPONSE_JITTER_MS = 120;

/**
 * How much longer to wait before answering, so that "no such account", "wrong password" and
 * "correct password" are indistinguishable by a stopwatch. Returns 0 when the work already took
 * longer than the floor — the floor is a minimum, never a maximum.
 */
export function remainingFloorMs(
  elapsedMs: number,
  floorMs: number = RESPONSE_FLOOR_MS,
  jitterMs: number = RESPONSE_JITTER_MS,
): number {
  const target = floorMs + (jitterMs > 0 ? randomInt(0, jitterMs) : 0);
  return Math.max(target - elapsedMs, 0);
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ── keys ─────────────────────────────────────────────────────────────────────

/**
 * Counter rows are keyed by a digest, never by the address itself. The table then holds no email
 * and no IP in the clear, so a dump of it tells an attacker which accounts exist only if they
 * already know which addresses to test.
 */
export function loginScopeKey(scope: LoginScope, ip: string | null, email: string | null): string {
  const source =
    scope === 'ip'
      ? `ip:${(ip ?? 'unknown').trim().toLowerCase()}`
      : `ip_email:${(ip ?? 'unknown').trim().toLowerCase()}|${(email ?? '').trim().toLowerCase()}`;
  return createHash('sha256').update(source, 'utf8').digest('hex');
}
