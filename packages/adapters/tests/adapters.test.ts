import { describe, expect, it, vi } from 'vitest';
import { InfraError } from '@infra/core';
import {
  checkAdapterHealth,
  classifyLatency,
  createAdapter,
  DIALECT_BY_PROVIDER,
  parseLibsqlConnectionString,
  withTimeout,
  worstStatus,
  type HealthReport,
} from '../src/index.js';
import { createFakeAdapter } from './fake-adapter.js';

describe('provider routing', () => {
  it('maps providers to dialects', () => {
    expect(DIALECT_BY_PROVIDER).toEqual({ neon: 'postgres', supabase: 'postgres', turso: 'libsql' });
  });

  it('refuses an unknown provider', () => {
    expect(() =>
      createAdapter({ provider: 'mysql' as never, connectionString: 'mysql://x' }),
    ).toThrowError(InfraError);
  });
});

describe('parseLibsqlConnectionString', () => {
  it('splits the auth token out of the DSN', () => {
    const parsed = parseLibsqlConnectionString('libsql://agentui-db-minkoi.turso.io?authToken=tok_123');
    expect(parsed.url).toBe('libsql://agentui-db-minkoi.turso.io');
    expect(parsed.authToken).toBe('tok_123');
    expect(parsed.url).not.toContain('tok_123');
  });

  it('works without a token', () => {
    const parsed = parseLibsqlConnectionString('libsql://local.turso.io');
    expect(parsed.authToken).toBeUndefined();
  });

  it('rejects junk', () => {
    expect(() => parseLibsqlConnectionString('nope')).toThrowError(InfraError);
  });
});

describe('withTimeout', () => {
  it('resolves fast operations untouched', async () => {
    await expect(withTimeout(Promise.resolve('done'), 50)).resolves.toBe('done');
  });

  it('rejects with DB_QUERY_TIMEOUT when the budget is exceeded', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 60));
    await expect(withTimeout(slow, 10)).rejects.toMatchObject({ code: 'DB_QUERY_TIMEOUT' });
  });
});

describe('health', () => {
  it('classifies latency bands', () => {
    expect(classifyLatency(50)).toBe('healthy');
    expect(classifyLatency(800)).toBe('degraded');
    expect(classifyLatency(4000)).toBe('down');
  });

  it('turns a thrown driver error into a down report', async () => {
    const report = await checkAdapterHealth(createFakeAdapter({ failHealth: true }));
    expect(report.status).toBe('down');
    expect(report.error).toContain('connection refused');
  });

  it('reports degraded for a slow but reachable database', async () => {
    const report = await checkAdapterHealth(createFakeAdapter({ latencyMs: 900 }));
    expect(report.status).toBe('degraded');
  });

  it('worstStatus surfaces the unhealthiest member', () => {
    const base: HealthReport = { status: 'healthy', latencyMs: 10, checkedAt: new Date() };
    expect(worstStatus([base, { ...base, status: 'degraded' }])).toBe('degraded');
    expect(worstStatus([base, { ...base, status: 'down' }, { ...base, status: 'degraded' }])).toBe('down');
    expect(worstStatus([base, base])).toBe('healthy');
  });
});

describe('adapter contract', () => {
  it('records the queries it receives with bound parameters', async () => {
    const adapter = createFakeAdapter();
    const spy = vi.spyOn(adapter, 'query');
    await adapter.query({ sql: 'select 1 from t where id = $1', params: ['abc'] });
    expect(spy).toHaveBeenCalledOnce();
    expect(adapter.queries[0]?.params).toEqual(['abc']);
  });
});
