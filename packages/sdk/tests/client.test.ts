import { describe, expect, it, vi } from 'vitest';
import { createInfraClient } from '../src/index.js';

const API_KEY = `pk_live_${'a1B2c3D4'.repeat(4)}`;
const BASE_URL = 'https://infra.example.com';

interface FakeResponseInit {
  status?: number;
  body?: unknown;
  requestId?: string;
}

function fakeFetch(init: FakeResponseInit = {}) {
  const status = init.status ?? 200;
  const calls: Array<{ url: string; options: RequestInit }> = [];

  const impl = vi.fn(async (url: string | URL | Request, options: RequestInit = {}) => {
    calls.push({ url: String(url), options });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'x-request-id': init.requestId ?? 'req_123' }),
      text: async () => (init.body === undefined ? '' : JSON.stringify(init.body)),
    } as unknown as Response;
  });

  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

describe('createInfraClient', () => {
  it('requires a baseUrl', () => {
    expect(() => createInfraClient({ baseUrl: '' })).toThrowError(/baseUrl is required/);
  });

  it('rejects a malformed api key', () => {
    expect(() => createInfraClient({ baseUrl: BASE_URL, apiKey: 'nope' })).toThrowError(/pk_live_/);
  });

  it('trims trailing slashes from the base url', () => {
    const client = createInfraClient({ baseUrl: `${BASE_URL}///`, apiKey: API_KEY });
    expect(client.baseUrl).toBe(BASE_URL);
  });
});

describe('db.query', () => {
  it('posts sql and params, and sends the api key as a bearer token', async () => {
    const { impl, calls } = fakeFetch({ body: { data: [{ id: 1 }] } });
    const infra = createInfraClient({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: impl });

    const result = await infra.db.query('select id from notes where owner = $1', ['u1']);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ id: 1 }]);

    const call = calls[0];
    expect(call?.url).toBe(`${BASE_URL}/api/v1/query`);
    expect(JSON.parse(String(call?.options.body))).toEqual({
      sql: 'select id from notes where owner = $1',
      params: ['u1'],
    });
    expect((call?.options.headers as Record<string, string>)['authorization']).toBe(`Bearer ${API_KEY}`);
  });

  it('never interpolates values into the sql string', async () => {
    const { impl, calls } = fakeFetch({ body: { data: [] } });
    const infra = createInfraClient({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: impl });

    await infra.db.query('select * from t where name = $1', ["'; drop table t; --"]);

    const sent = JSON.parse(String(calls[0]?.options.body)) as { sql: string; params: string[] };
    expect(sent.sql).not.toContain('drop table');
    expect(sent.params[0]).toContain('drop table');
  });

  it('returns an error value instead of throwing on 401', async () => {
    const { impl } = fakeFetch({ status: 401, body: { error: { code: 'API_KEY_REVOKED', message: 'revoked' } } });
    const infra = createInfraClient({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: impl });

    const result = await infra.db.query('select 1');

    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ code: 'API_KEY_REVOKED', message: 'revoked', requestId: 'req_123' });
  });

  it('maps an unknown error shape by http status', async () => {
    const { impl } = fakeFetch({ status: 429, body: {} });
    const infra = createInfraClient({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: impl });
    const result = await infra.db.query('select 1');
    expect(result.error?.code).toBe('RATE_LIMITED');
  });

  it('turns a transport failure into NETWORK_ERROR', async () => {
    const failing = vi.fn(async () => {
      throw new Error('econnrefused');
    }) as unknown as typeof globalThis.fetch;
    const infra = createInfraClient({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: failing });

    const result = await infra.db.query('select 1');
    expect(result.error?.code).toBe('NETWORK_ERROR');
  });

  it('queryOne returns the first row or null', async () => {
    const withRows = createInfraClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: fakeFetch({ body: { data: [{ id: 7 }, { id: 8 }] } }).impl,
    });
    await expect(withRows.db.queryOne('select 1')).resolves.toEqual({ data: { id: 7 }, error: null });

    const empty = createInfraClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: fakeFetch({ body: { data: [] } }).impl,
    });
    await expect(empty.db.queryOne('select 1')).resolves.toEqual({ data: null, error: null });
  });
});

describe('auth', () => {
  it('signs in with email over cookies, without the api key header', async () => {
    const { impl, calls } = fakeFetch({ body: { data: { user: { id: 'u1' } } } });
    const infra = createInfraClient({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: impl });

    await infra.auth.signIn.email({ email: 'a@b.com', password: 'pw' });

    const headers = calls[0]?.options.headers as Record<string, string>;
    expect(calls[0]?.url).toBe(`${BASE_URL}/api/auth/sign-in/email`);
    expect(headers['authorization']).toBeUndefined();
    expect(calls[0]?.options.credentials).toBe('include');
  });

  it('starts a social sign-in and returns the redirect url', async () => {
    const { impl, calls } = fakeFetch({ body: { data: { url: 'https://accounts.google.com/o/oauth2/v2/auth' } } });
    const infra = createInfraClient({ baseUrl: BASE_URL, fetch: impl });

    const result = await infra.auth.signIn.social('google', { callbackUrl: '/dashboard' });

    expect(result.data?.url).toContain('accounts.google.com');
    expect(JSON.parse(String(calls[0]?.options.body))).toEqual({
      provider: 'google',
      callbackURL: '/dashboard',
    });
  });

  it('getSession returns null when nobody is signed in', async () => {
    const { impl } = fakeFetch({ body: { data: null } });
    const infra = createInfraClient({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: impl });
    await expect(infra.auth.getSession()).resolves.toEqual({ data: null, error: null });
  });
});
