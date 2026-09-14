/**
 * The refresh queue.
 *
 * The headline test is "coalesces a stampede into one refresh". It is not a performance test: with
 * rotation and reuse detection on the server, a second concurrent refresh presents a token that has
 * just been burned, and the platform responds by revoking the whole family. Without coalescing, a
 * page that fires five parallel requests logs the user out.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SKEW_MS,
  isReuseDetected,
  memoryStorage,
  TokenManager,
  type RefreshOutcome,
  type TokenPair,
} from '../src/token-manager.js';

const NOW = 1_700_000_000_000;

const pair = (over: Partial<TokenPair> = {}): TokenPair => ({
  accessToken: 'at_1',
  refreshToken: 'rt_1',
  expiresAt: NOW + 600_000,
  ...over,
});

function manager(
  initial: TokenPair | null,
  refresh: (token: string) => Promise<RefreshOutcome>,
  extra: { now?: () => number; onSessionEnded?: (reason: string) => void } = {},
) {
  const storage = memoryStorage(initial);
  const options = {
    storage,
    refresh,
    now: extra.now ?? (() => NOW),
    ...(extra.onSessionEnded === undefined ? {} : { onSessionEnded: extra.onSessionEnded }),
  };
  return { manager: new TokenManager(options), storage };
}

describe('freshness', () => {
  it('uses a token that is comfortably in date, without a network call', async () => {
    const refresh = vi.fn();
    const { manager: m } = manager(pair(), refresh as never);

    expect(await m.getAccessToken()).toBe('at_1');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes before expiry, not after — so a request never sees a 401', async () => {
    // Inside the skew window but not yet expired.
    const soon = pair({ expiresAt: NOW + DEFAULT_SKEW_MS - 1_000 });
    const refresh = vi.fn(async () => ({ pair: pair({ accessToken: 'at_2', refreshToken: 'rt_2' }) }));
    const { manager: m } = manager(soon, refresh);

    expect(await m.getAccessToken()).toBe('at_2');
    expect(refresh).toHaveBeenCalledWith('rt_1');
  });

  it('reports a pair as expiring only inside the skew window', () => {
    const { manager: m } = manager(null, async () => ({ pair: null }));
    expect(m.isExpiring(pair({ expiresAt: NOW + DEFAULT_SKEW_MS + 1 }))).toBe(false);
    expect(m.isExpiring(pair({ expiresAt: NOW + DEFAULT_SKEW_MS }))).toBe(true);
    expect(m.isExpiring(pair({ expiresAt: NOW - 1 }))).toBe(true);
  });

  it('returns null when nobody is signed in — an absent session is not an error', async () => {
    const { manager: m } = manager(null, async () => ({ pair: null }));
    expect(await m.getAccessToken()).toBeNull();
  });
});

describe('single-flight', () => {
  it('coalesces a stampede into exactly one refresh', async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const refresh = async (): Promise<RefreshOutcome> => {
      calls += 1;
      await gate;
      return { pair: pair({ accessToken: 'at_fresh', refreshToken: 'rt_2' }) };
    };

    const { manager: m } = manager(pair({ expiresAt: NOW - 1 }), refresh);

    // Five requests discover the stale token at the same moment.
    const all = Promise.all([
      m.getAccessToken(),
      m.getAccessToken(),
      m.getAccessToken(),
      m.getAccessToken(),
      m.getAccessToken(),
    ]);

    release?.();
    const tokens = await all;

    // One rotation, one new token, five happy callers. Two rotations would have burned the first
    // refresh token and tripped reuse detection on the server.
    expect(calls).toBe(1);
    expect(tokens).toEqual(['at_fresh', 'at_fresh', 'at_fresh', 'at_fresh', 'at_fresh']);
  });

  it('starts a fresh refresh once the previous one has settled', async () => {
    let calls = 0;
    const refresh = async (): Promise<RefreshOutcome> => {
      calls += 1;
      return { pair: pair({ accessToken: `at_${calls}`, expiresAt: NOW - 1 }) };
    };

    const { manager: m } = manager(pair({ expiresAt: NOW - 1 }), refresh);

    await m.getAccessToken();
    await m.getAccessToken();
    expect(calls).toBe(2);
  });

  it('does not leave the in-flight promise stuck after a rejection', async () => {
    let calls = 0;
    const refresh = async (): Promise<RefreshOutcome> => {
      calls += 1;
      if (calls === 1) throw new Error('network blip');
      return { pair: pair({ accessToken: 'at_recovered' }) };
    };

    const { manager: m } = manager(pair({ expiresAt: NOW - 1 }), refresh);

    await expect(m.getAccessToken()).rejects.toThrow('network blip');
    // A stuck in-flight promise would make every later call fail with the same stale rejection.
    expect(await m.getAccessToken()).toBe('at_recovered');
  });

  it('persists the new pair so the next request does not refresh again', async () => {
    const refresh = async (): Promise<RefreshOutcome> => ({
      pair: pair({ accessToken: 'at_2', refreshToken: 'rt_2' }),
    });
    const { manager: m, storage } = manager(pair({ expiresAt: NOW - 1 }), refresh);

    await m.getAccessToken();
    expect(await storage.load()).toMatchObject({ accessToken: 'at_2', refreshToken: 'rt_2' });
  });
});

describe('terminal failures', () => {
  it('ends the session on reuse detection and stops trying', async () => {
    let calls = 0;
    const ended: string[] = [];
    const refresh = async (): Promise<RefreshOutcome> => {
      calls += 1;
      return {
        pair: null,
        terminal: { code: 'UNAUTHENTICATED', message: 'refresh token was already used' },
      };
    };

    const { manager: m, storage } = manager(pair({ expiresAt: NOW - 1 }), refresh, {
      onSessionEnded: (reason) => ended.push(reason),
    });

    expect(await m.getAccessToken()).toBeNull();
    expect(m.sessionEnded).toBe(true);
    expect(await storage.load()).toBeNull();
    expect(ended).toHaveLength(1);

    // Further calls must not hammer an endpoint that has nothing left to give.
    expect(await m.getAccessToken()).toBeNull();
    expect(calls).toBe(1);
  });

  it('notifies the app exactly once so it can redirect to sign-in', async () => {
    const ended: string[] = [];
    const { manager: m } = manager(pair(), async () => ({ pair: null }), {
      onSessionEnded: (reason) => ended.push(reason),
    });

    await m.endSession('signed out');
    expect(ended).toEqual(['signed out']);
  });

  it('a non-terminal refresh failure leaves the session alive for a later retry', async () => {
    const { manager: m, storage } = manager(pair({ expiresAt: NOW - 1 }), async () => ({ pair: null }));

    expect(await m.getAccessToken()).toBeNull();
    expect(m.sessionEnded).toBe(false);
    expect(await storage.load()).not.toBeNull();
  });

  it('accepts a new session after one ended', async () => {
    const { manager: m } = manager(null, async () => ({ pair: null }));
    await m.endSession();
    expect(m.sessionEnded).toBe(true);

    await m.setTokens(pair({ accessToken: 'at_new' }));
    expect(m.sessionEnded).toBe(false);
    expect(await m.getAccessToken()).toBe('at_new');
  });
});

describe('isReuseDetected', () => {
  it('separates a replayed token from an ordinary expiry', () => {
    expect(
      isReuseDetected({ code: 'UNAUTHENTICATED', message: 'refresh token was already used' }),
    ).toBe(true);
    expect(isReuseDetected({ code: 'UNAUTHENTICATED', message: 'token has expired' })).toBe(false);
    expect(isReuseDetected({ code: 'FORBIDDEN_SCOPE', message: 'reuse' })).toBe(false);
    expect(isReuseDetected(null)).toBe(false);
  });
});
