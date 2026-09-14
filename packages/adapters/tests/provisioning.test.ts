/**
 * The provisioners are tested against a scripted fetch rather than a live provider: what matters
 * here is not that Neon's API works, but that a failure part-way through never leaves a resource
 * behind that nothing points at.
 */
import { describe, expect, it } from 'vitest';
import { InfraError } from '@infra/core';
import { NeonProvisioner } from '../src/provisioning/neon.provisioner.js';
import { TursoProvisioner } from '../src/provisioning/turso.provisioner.js';
import { hostHintFrom, providerFetch } from '../src/provisioning/http.js';
import { FREE_TIER_LIMITS } from '../src/provisioning/types.js';
import { createProvisioner, PROVISIONABLE_PROVIDERS } from '../src/provisioning/index.js';

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | null;
}

/** Records every call and answers from a script keyed by `METHOD path-substring`. */
function scriptedFetch(script: Record<string, { status?: number; body?: unknown }>) {
  const calls: Call[] = [];

  const impl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof url === 'string' ? url : url.toString();
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? 'GET',
      url: href,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      auth: headers.get('authorization'),
    });

    // Longest fragment first: '/databases/x/auth/tokens' also contains '/databases', and the
    // token route must not be answered by the create-database script entry.
    const key = Object.keys(script)
      .sort((a, b) => b.length - a.length)
      .find((candidate) => {
        const [method, fragment] = candidate.split(' ');
        return method === (init?.method ?? 'GET') && fragment !== undefined && href.includes(fragment);
      });

    const entry = key === undefined ? { status: 404, body: {} } : script[key] ?? {};
    const status = entry.status ?? 200;
    return new Response(JSON.stringify(entry.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

const NEON_OK = {
  'POST /projects': {
    body: {
      project: { id: 'proj_123', region_id: 'aws-us-east-2' },
      connection_uris: [{ connection_uri: 'postgresql://u:pw@ep-x.neon.tech/neondb?sslmode=require' }],
    },
  },
  'DELETE /projects/': { status: 204 },
};

describe('NeonProvisioner', () => {
  it('is not configured without an api key, and refuses rather than half-working', async () => {
    const provisioner = new NeonProvisioner({ apiKey: '' });
    expect(provisioner.isConfigured()).toBe(false);
    await expect(provisioner.provision({ slug: 'demo' })).rejects.toBeInstanceOf(InfraError);
  });

  it('creates a project and returns a sealed-ready connection string', async () => {
    const { impl, calls } = scriptedFetch(NEON_OK);
    const result = await new NeonProvisioner({ apiKey: 'k', fetchImpl: impl }).provision({ slug: 'demo' });

    expect(result.provider).toBe('neon');
    expect(result.externalId).toBe('proj_123');
    expect(result.connectionString).toContain('neon.tech');
    expect(result.hostHint).toBe('ep-x.neon.tech');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.auth).toBe('Bearer k');
  });

  it('names the project after the app slug so a human can match them up', async () => {
    const { impl, calls } = scriptedFetch(NEON_OK);
    await new NeonProvisioner({ apiKey: 'k', fetchImpl: impl }).provision({ slug: 'learning-ai' });
    expect(JSON.stringify(calls[0]?.body)).toContain('uai-learning-ai');
  });

  it('deletes the project when no connection string comes back — no orphan, no lost quota slot', async () => {
    const { impl, calls } = scriptedFetch({
      'POST /projects': { body: { project: { id: 'proj_orphan' }, connection_uris: [] } },
      'DELETE /projects/': { status: 204 },
    });

    await expect(
      new NeonProvisioner({ apiKey: 'k', fetchImpl: impl }).provision({ slug: 'demo' }),
    ).rejects.toBeInstanceOf(InfraError);

    const deletes = calls.filter((call) => call.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url).toContain('proj_orphan');
  });

  it('treats a 404 on delete as success — already gone is the desired end state', async () => {
    const { impl } = scriptedFetch({ 'DELETE /projects/': { status: 404 } });
    await expect(
      new NeonProvisioner({ apiKey: 'k', fetchImpl: impl }).deprovision('proj_gone'),
    ).resolves.toBeUndefined();
  });

  it('reports usage against the published free-tier ceiling', async () => {
    const { impl } = scriptedFetch({ 'GET /projects': { body: { projects: [{ id: 'a' }, { id: 'b' }] } } });
    const usage = await new NeonProvisioner({ apiKey: 'k', fetchImpl: impl }).usage();
    expect(usage).toMatchObject({ provider: 'neon', used: 2, limit: FREE_TIER_LIMITS.neon });
  });
});

describe('TursoProvisioner', () => {
  const TURSO_OK = {
    'POST /databases': { body: { database: { Name: 'uai-demo', Hostname: 'uai-demo-org.turso.io' } } },
    'POST /auth/tokens': { body: { jwt: 'ey.token.value' } },
    'DELETE /databases/': { status: 204 },
  };

  it('needs both a token and an organization', () => {
    expect(new TursoProvisioner({ apiToken: 't', organization: '' }).isConfigured()).toBe(false);
    expect(new TursoProvisioner({ apiToken: '', organization: 'o' }).isConfigured()).toBe(false);
    expect(new TursoProvisioner({ apiToken: 't', organization: 'o' }).isConfigured()).toBe(true);
  });

  it('creates the database then mints a token scoped to it', async () => {
    const { impl, calls } = scriptedFetch(TURSO_OK);
    const result = await new TursoProvisioner({
      apiToken: 't',
      organization: 'acme',
      fetchImpl: impl,
    }).provision({ slug: 'demo' });

    expect(result.connectionString).toBe('libsql://uai-demo-org.turso.io?authToken=ey.token.value');
    expect(result.hostHint).toBe('uai-demo-org.turso.io');
    // The token call names one database — not an org-wide token that would open every app's data.
    expect(calls[1]?.url).toContain('/databases/uai-demo/auth/tokens');
  });

  it('deletes the database when the token call fails', async () => {
    const { impl, calls } = scriptedFetch({
      'POST /databases': { body: { database: { Name: 'uai-demo', Hostname: 'h.turso.io' } } },
      'POST /auth/tokens': { status: 500 },
      'DELETE /databases/': { status: 204 },
    });

    await expect(
      new TursoProvisioner({ apiToken: 't', organization: 'acme', fetchImpl: impl }).provision({
        slug: 'demo',
      }),
    ).rejects.toBeInstanceOf(InfraError);

    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  it('sanitises the slug into a name the provider will accept', async () => {
    const { impl, calls } = scriptedFetch(TURSO_OK);
    await new TursoProvisioner({ apiToken: 't', organization: 'acme', fetchImpl: impl }).provision({
      slug: 'My_App.v2',
    });
    const body = calls[0]?.body as { name?: string };
    expect(body.name).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('providerFetch', () => {
  it('never puts the provider response body into the error', async () => {
    const { impl } = scriptedFetch({});
    const body = { message: 'token sk_live_leaked_value was rejected' };
    const failing = (async () =>
      new Response(JSON.stringify(body), { status: 400 })) as unknown as typeof fetch;

    await expect(
      providerFetch({ method: 'GET', url: 'https://x/y', token: 't', fetchImpl: failing }),
    ).rejects.toThrowError(/provider rejected/);

    try {
      await providerFetch({ method: 'GET', url: 'https://x/y', token: 't', fetchImpl: failing });
    } catch (error) {
      expect(JSON.stringify(error instanceof InfraError ? error.toJSON() : {})).not.toContain('sk_live');
    }
    expect(impl).toBeDefined();
  });

  it('turns a timeout into its own error code', async () => {
    const hanging = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as unknown as typeof fetch;

    await expect(
      providerFetch({ method: 'GET', url: 'https://x/y', token: 't', fetchImpl: hanging, timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'DB_QUERY_TIMEOUT' });
  });
});

describe('hostHintFrom', () => {
  it('keeps host and port and drops the credentials', () => {
    expect(hostHintFrom('postgresql://user:secret@db.example.com:6543/x')).toBe('db.example.com:6543');
    expect(hostHintFrom('postgresql://user:secret@db.example.com:6543/x')).not.toContain('secret');
  });

  it('returns null for junk rather than guessing', () => {
    expect(hostHintFrom('not a url')).toBeNull();
  });
});

describe('registry', () => {
  it('offers neon and turso, and says plainly that supabase has no api', () => {
    expect([...PROVISIONABLE_PROVIDERS]).toEqual(['neon', 'turso']);
    expect(() => createProvisioner('supabase')).toThrowError(/supabase/);
  });
});
