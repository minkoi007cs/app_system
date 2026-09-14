import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  decay,
  EMPTY_ATTEMPT,
  evaluateAttempt,
  IP_EMAIL_POLICY,
  IP_POLICY,
  lockoutFor,
  loginScopeKey,
  remainingFloorMs,
  strictest,
  type AttemptState,
} from '../src/throttle.js';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

describe('lockoutFor', () => {
  it('costs nothing up to and including the free attempts', () => {
    for (let n = 0; n <= IP_EMAIL_POLICY.freeAttempts; n += 1) {
      expect(lockoutFor(n, IP_EMAIL_POLICY)).toBe(0);
    }
  });

  it('doubles from the base once the free attempts are spent', () => {
    const { freeAttempts, baseLockoutMs } = IP_EMAIL_POLICY;
    expect(lockoutFor(freeAttempts + 1, IP_EMAIL_POLICY)).toBe(baseLockoutMs);
    expect(lockoutFor(freeAttempts + 2, IP_EMAIL_POLICY)).toBe(baseLockoutMs * 2);
    expect(lockoutFor(freeAttempts + 3, IP_EMAIL_POLICY)).toBe(baseLockoutMs * 4);
  });

  it('caps — a lockout never becomes a permanent one', () => {
    expect(lockoutFor(1_000, IP_EMAIL_POLICY)).toBe(IP_EMAIL_POLICY.maxLockoutMs);
    expect(lockoutFor(Number.MAX_SAFE_INTEGER, IP_POLICY)).toBe(IP_POLICY.maxLockoutMs);
    expect(Number.isFinite(lockoutFor(10_000, IP_POLICY))).toBe(true);
  });
});

describe('decay', () => {
  it('forgets a counter that has gone quiet for longer than the ttl', () => {
    const stale: AttemptState = { failureCount: 9, lastFailureAt: T0, lockedUntil: at(1_000) };
    const after = decay(stale, IP_EMAIL_POLICY, at(IP_EMAIL_POLICY.counterTtlMs + 1));
    expect(after).toEqual(EMPTY_ATTEMPT);
  });

  it('keeps a recent counter intact', () => {
    const recent: AttemptState = { failureCount: 3, lastFailureAt: T0, lockedUntil: null };
    expect(decay(recent, IP_EMAIL_POLICY, at(1_000))).toEqual(recent);
  });
});

describe('evaluateAttempt', () => {
  it('allows an untouched identity', () => {
    expect(evaluateAttempt(EMPTY_ATTEMPT, IP_EMAIL_POLICY, T0)).toEqual({
      allowed: true,
      retryAfterMs: 0,
      failureCount: 0,
    });
  });

  it('refuses while the lockout window is open and reports the remaining time', () => {
    const locked: AttemptState = { failureCount: 6, lastFailureAt: T0, lockedUntil: at(30_000) };
    const verdict = evaluateAttempt(locked, IP_EMAIL_POLICY, at(10_000));
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterMs).toBe(20_000);
  });

  it('allows again the moment the window closes', () => {
    const locked: AttemptState = { failureCount: 6, lastFailureAt: T0, lockedUntil: at(30_000) };
    expect(evaluateAttempt(locked, IP_EMAIL_POLICY, at(30_000)).allowed).toBe(true);
  });

  it('a decayed counter is not locked out even if lockedUntil is still in the future', () => {
    const ttl = IP_EMAIL_POLICY.counterTtlMs;
    const stale: AttemptState = { failureCount: 40, lastFailureAt: T0, lockedUntil: at(ttl + 10_000) };
    expect(evaluateAttempt(stale, IP_EMAIL_POLICY, at(ttl + 1)).allowed).toBe(true);
  });
});

describe('afterFailure', () => {
  it('walks the curve one failure at a time', () => {
    let state = EMPTY_ATTEMPT;
    for (let n = 1; n <= IP_EMAIL_POLICY.freeAttempts; n += 1) {
      state = afterFailure(state, IP_EMAIL_POLICY, T0);
      expect(state.failureCount).toBe(n);
      expect(state.lockedUntil).toBeNull();
    }

    state = afterFailure(state, IP_EMAIL_POLICY, T0);
    expect(state.failureCount).toBe(IP_EMAIL_POLICY.freeAttempts + 1);
    expect(state.lockedUntil?.getTime()).toBe(T0.getTime() + IP_EMAIL_POLICY.baseLockoutMs);
  });

  it('restarts the count after the counter has decayed', () => {
    const old: AttemptState = { failureCount: 12, lastFailureAt: T0, lockedUntil: at(60_000) };
    const next = afterFailure(old, IP_EMAIL_POLICY, at(IP_EMAIL_POLICY.counterTtlMs + 1));
    expect(next.failureCount).toBe(1);
    expect(next.lockedUntil).toBeNull();
  });
});

describe('strictest', () => {
  it('returns allowed only when every scope agrees', () => {
    const allow = { allowed: true, retryAfterMs: 0, failureCount: 2 };
    const deny = { allowed: false, retryAfterMs: 5_000, failureCount: 9 };
    expect(strictest([allow, deny]).allowed).toBe(false);
    expect(strictest([allow, deny]).retryAfterMs).toBe(5_000);
    expect(strictest([allow, allow]).allowed).toBe(true);
  });

  it('takes the longest wait among the refusals', () => {
    const short = { allowed: false, retryAfterMs: 1_000, failureCount: 6 };
    const long = { allowed: false, retryAfterMs: 90_000, failureCount: 7 };
    expect(strictest([short, long]).retryAfterMs).toBe(90_000);
  });

  it('reports the highest failure count seen', () => {
    expect(
      strictest([
        { allowed: true, retryAfterMs: 0, failureCount: 3 },
        { allowed: true, retryAfterMs: 0, failureCount: 11 },
      ]).failureCount,
    ).toBe(11);
  });
});

describe('remainingFloorMs', () => {
  it('pads a fast answer up to at least the floor', () => {
    expect(remainingFloorMs(0, 300, 0)).toBe(300);
    expect(remainingFloorMs(100, 300, 0)).toBe(200);
  });

  it('never returns a negative wait — the floor is a minimum, not a maximum', () => {
    expect(remainingFloorMs(5_000, 300, 0)).toBe(0);
  });

  it('adds jitter inside the requested band', () => {
    for (let n = 0; n < 50; n += 1) {
      const value = remainingFloorMs(0, 300, 120);
      expect(value).toBeGreaterThanOrEqual(300);
      expect(value).toBeLessThan(420);
    }
  });
});

describe('loginScopeKey', () => {
  it('is a digest — neither the address nor the ip survives in it', () => {
    const key = loginScopeKey('ip_email', '203.0.113.9', 'alice@example.com');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('alice');
    expect(key).not.toContain('203.0.113.9');
  });

  it('ignores case and surrounding whitespace in the email', () => {
    expect(loginScopeKey('ip_email', '1.2.3.4', ' Alice@Example.com ')).toBe(
      loginScopeKey('ip_email', '1.2.3.4', 'alice@example.com'),
    );
  });

  it('separates the two scopes and the two identities', () => {
    expect(loginScopeKey('ip', '1.2.3.4', null)).not.toBe(loginScopeKey('ip_email', '1.2.3.4', null));
    expect(loginScopeKey('ip_email', '1.2.3.4', 'a@e.com')).not.toBe(
      loginScopeKey('ip_email', '1.2.3.4', 'b@e.com'),
    );
  });

  it('buckets an unknown ip rather than throwing', () => {
    expect(loginScopeKey('ip', null, null)).toMatch(/^[0-9a-f]{64}$/);
  });
});
