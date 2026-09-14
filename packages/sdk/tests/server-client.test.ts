/**
 * createServerClient — the per-request contract.
 *
 * The test that matters most is the isolation one: two requests handled concurrently in the same
 * process must never see each other's token. That failure is silent in production (user B's page
 * renders user A's data, no error anywhere), so it gets an explicit test rather than a convention.
 */
import { describe, expect, it } from 'vitest';
import { createServerClient } from '../src/server-client.js';
import { memoryStorage, type TokenPair } from '../src/token-manager.js';

const BASE = 'https://infra.test';
const KEY = 'sk_live_' + 'a'.repeat(32);
const NOW = Date.now();

const pair = (over: Partial<TokenPair> = {}): TokenPair => ({
  accessToken: 'at_1',
  refreshToken: 'rt_1',
  expiresAt: NOW + 600_000,
  ...over,
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stand-in that records calls and answers from a queue of responses. */
function recorder(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  let index = 0;

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });

    calls.push({
      url: url.toString(),
      headers,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(next?.body ?? {}), {
      status: next?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { impl, calls };
}

const rowsOk = { status: 200, body: { data: { rows: [{ id: 1 }], rowCount: 1, durationMs: 2 } } };
const unauthorised = {
  status: 401,
  body: { error: { code: 'UNAUTHENTICATED', message: 'token expired', requestId: 'req_1' } },
};

describe('construction', () => {
  it('requires a storage adapter, and says why', () => {
    expect(() =>
      createServerClient({ baseUrl: BASE, apiKey: KEY } as never),
    ).toThrowError(/storage adapter/);
  });

  it('requires a baseUrl', () => {
    expect(() => createServerClient({ baseUrl: '', storage: memoryStorage() })).toThrowError(/baseUrl/);
  });

  it('accepts a secret key — this is server code', () => {
    const client = createServerClient({ baseUrl: BASE, apiKey: KEY, storage: memoryStorage() });
    expect(client.baseUrl).toBe(BASE);
  });
});

describe('per-request token handling', () => {
  it('sends the user token in the cross-domain header, never as a cookie', async () => {
    const { impl, calls } = recorder([rowsOk]);
    const client = createServerClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: impl,
      storage: memoryStorage(pair()),
    });

    await client.from('notes').select('id').run();

    expect(calls[0]?.headers['x-infra-access-token']).toBe('at_1');
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.headers['cookie']).toBeUndefined();
  });

  it('keeps two concurrent requests apart', async () => {
    // Two clients, two storages — the shape createServerClient is designed to force.
    const a = recorder([rowsOk]);
    const b = recorder([rowsOk]);

    const clientA = createServerClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: a.impl,
      storage: memoryStorage(pair({ accessToken: 'at_userA' })),
    });
    const clientB = createServerClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: b.impl,
      storage: memoryStorage(pair({ accessToken: 'at_userB' })),
    });

    await Promise.all([clientA.from('notes').run(), clientB.from('notes').run()]);

    expect(a.calls[0]?.headers['x-infra-access-token']).toBe('at_userA');
    expect(b.calls[0]?.headers['x-infra-access-token']).toBe('at_userB');
  });

  it('works with no session at all — the header is simply absent', async () => {
    const { impl, calls } = recorder([rowsOk]);
    const client = createServerClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: impl,
      storage: memoryStorage(null),
    });

    await client.from('notes').run();
    expect(calls[0]?.headers['x-infra-access-token']).toBeUndefined();
    expect(await client.accessToken()).toBeNull();
  });
});

describe('refresh and retry', () => {
  it('refreshes once on a 401 and retries the call with the new token', async () => {
    const { impl, calls } = recorder([
      unauthorised,
      {
        status: 200,
        body: { data: { access_token: 'at_2', refresh_token: 'rt_2', expires_in: 600 } },
      },
      rowsOk,
    ]);

    const client = createServerClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: impl,
      storage: memoryStorage(pair()),
    });

    const result = await client.from('notes').run();

    expect(result.error).toBeNull();
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toContain('/api/v1/auth/refresh');
    expect(calls[2]?.headers['x-infra-access-token']).toBe('at_2');
  });

  it('retries once, never in a loop', async () => {
    const { impl, calls } = recorder([
      unauthorised,
      { status: 200, body: { data: { access_token: 'at_2', refresh_token: 'rt_2', expires_in: 600 } } },
      unauthorised,
      unauthorised,
    ]);

    const client = createServerClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: impl,
      storage: memoryStorage(pair()),
    });

    const result = await client.from('notes').run();

    // query, refresh, query. A 401 that survives a fresh token is a real denial.
    expect(calls).toHaveLength(3);
    expect(result.error?.code).toBe('UNAUTHENTICATED');
  });

  it('ends the session on reuse detection instead of retrying', async () => {
    const ended: string[] = [];
    const { impl, calls } = recorder([
      {
        status: 401,
        body: {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'refresh token was already used — every session in this family has been revoked',
            requestId: 'req_9',
          },
        },
      },
    ]);

    const client = createServerClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: impl,
      storage: memoryStorage(pair()),
      onSessionEnded: (reason) => ended.push(reason),
    });

    const result = await client.from('notes').run();

    expect(calls).toHaveLength(1);
    expect(result.error?.code).toBe('UNAUTHENTICATED');
    expect(client.tokens.sessionEnded).toBe(true);
    expect(ended).toHaveLength(1);
  });

  it('refreshes proactively, before a request ever gets a 401', async () => {
    const { impl, calls } = recorder([
      { status: 200, body: { data: { access_token: 'at_2', refresh_token: 'rt_2', expires_in: 600 } } },
      rowsOk,
    ]);

    const client = createServerClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: impl,
      storage: memoryStorage(pair({ expiresAt: Date.now() + 5_000 })),
    });

    await client.from('notes').run();

    expect(calls[0]?.url).toContain('/api/v1/auth/refresh');
    expect(calls[1]?.headers['x-infra-access-token']).toBe('at_2');
  });
});

describe('signOut', () => {
  it('clears locally first, then asks the hub to revoke', async () => {
    const { impl, calls } = recorder([{ status: 200, body: { data: null } }]);
    const storage = memoryStorage(pair());

    const client = createServerClient({ baseUrl: BASE, apiKey: KEY, fetch: impl, storage });
    await client.signOut();

    expect(await storage.load()).toBeNull();
    expect(calls[0]?.url).toContain('/api/v1/auth/revoke');
    expect(calls[0]?.body).toEqual({ refresh_token: 'rt_1' });
  });

  it('still clears local state when the hub cannot be reached', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as typeof fetch;

    const storage = memoryStorage(pair());
    const client = createServerClient({ baseUrl: BASE, apiKey: KEY, fetch: failing, storage });

    const result = await client.signOut();

    // The local session is gone regardless — this process must stop presenting the token.
    expect(await storage.load()).toBeNull();
    expect(result.error?.code).toBe('NETWORK_ERROR');
  });

  it('is a no-op when there was no session', async () => {
    const { impl, calls } = recorder([{ status: 200, body: { data: null } }]);
    const client = createServerClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: impl,
      storage: memoryStorage(null),
    });

    const result = await client.signOut();
    expect(result.error).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('setSession', () => {
  it('stores a freshly minted pair for the rest of the request', async () => {
    const storage = memoryStorage(null);
    const client = createServerClient({ baseUrl: BASE, apiKey: KEY, storage });

    await client.setSession(pair({ accessToken: 'at_signed_in' }));

    expect(await client.accessToken()).toBe('at_signed_in');
    expect(await storage.load()).toMatchObject({ accessToken: 'at_signed_in' });
  });
});
