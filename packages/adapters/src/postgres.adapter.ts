/**
 * PostgreSQL adapter — serves both Neon and Supabase.
 * Supabase must be reached through its transaction pooler (port 6543), so prepared
 * statements are disabled; free tiers also hand out very few connection slots.
 */
import postgres from 'postgres';
import { InfraError } from '@infra/core';
import {
  classifyLatency,
  DEFAULT_POOL_MAX,
  DEFAULT_QUERY_TIMEOUT_MS,
  type AdapterConfig,
  type DatabaseAdapter,
  type HealthReport,
  type QueryRequest,
  type QueryResult,
} from './types.js';
import { toPostgresParams } from './params.js';
import { withTimeout } from './timeout.js';

export function createPostgresAdapter(config: AdapterConfig): DatabaseAdapter {
  if (config.provider !== 'neon' && config.provider !== 'supabase') {
    throw new InfraError('CONFIG_INVALID', `provider ${config.provider} is not a postgres provider`);
  }

  const provider = config.provider;
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  const sql = postgres(config.connectionString, {
    max: config.poolMax ?? DEFAULT_POOL_MAX,
    idle_timeout: 30,
    connect_timeout: 10,
    // Supabase's pgbouncer cannot replay prepared statements across pooled connections.
    prepare: false,
    onnotice: () => {},
  });

  async function query<R = Record<string, unknown>>(request: QueryRequest): Promise<QueryResult<R>> {
    const started = Date.now();
    const params = toPostgresParams(request.params ?? []);

    try {
      // sql.unsafe(text, params) still binds parameters server-side — no interpolation happens.
      const rows = await withTimeout(
        sql.unsafe(request.sql, params),
        request.timeoutMs ?? defaultTimeoutMs,
        { provider },
      );
      const list = rows as unknown as R[];
      return { rows: list, rowCount: list.length, durationMs: Date.now() - started };
    } catch (cause) {
      if (InfraError.is(cause)) throw cause;
      throw new InfraError('DB_QUERY_FAILED', 'tenant query failed', {
        cause,
        details: { provider, durationMs: Date.now() - started },
      });
    }
  }

  async function health(): Promise<HealthReport> {
    const started = Date.now();
    try {
      await withTimeout(sql`select 1`, defaultTimeoutMs, { provider });
      const latencyMs = Date.now() - started;
      return { status: classifyLatency(latencyMs), latencyMs, checkedAt: new Date() };
    } catch (cause) {
      return {
        status: 'down',
        latencyMs: null,
        checkedAt: new Date(),
        error: cause instanceof Error ? cause.message : 'unknown error',
      };
    }
  }

  async function close(): Promise<void> {
    await sql.end({ timeout: 5 });
  }

  return { dialect: 'postgres', provider, query, health, close };
}
