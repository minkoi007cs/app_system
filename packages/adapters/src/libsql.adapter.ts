/**
 * LibSQL adapter — Turso.
 * The auth token travels inside the DSN query string, so it is split out here and
 * never re-serialised anywhere else.
 */
import { createClient, type Client } from '@libsql/client';
import { InfraError } from '@infra/core';
import {
  classifyLatency,
  DEFAULT_QUERY_TIMEOUT_MS,
  type AdapterConfig,
  type DatabaseAdapter,
  type HealthReport,
  type QueryRequest,
  type QueryResult,
} from './types.js';
import { toLibsqlParams } from './params.js';
import { withTimeout } from './timeout.js';

export interface LibsqlConnection {
  url: string;
  authToken?: string;
}

/** Splits `libsql://db.turso.io?authToken=…` into its url and token. */
export function parseLibsqlConnectionString(connectionString: string): LibsqlConnection {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new InfraError('CONFIG_INVALID', 'libsql connection string is not a valid URL');
  }

  const authToken = parsed.searchParams.get('authToken') ?? undefined;
  parsed.searchParams.delete('authToken');
  const url = parsed.toString().replace(/\?$/, '');

  return authToken === undefined ? { url } : { url, authToken };
}

export function createLibsqlAdapter(config: AdapterConfig): DatabaseAdapter {
  if (config.provider !== 'turso') {
    throw new InfraError('CONFIG_INVALID', `provider ${config.provider} is not a libsql provider`);
  }

  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const connection = parseLibsqlConnectionString(config.connectionString);
  const client: Client = createClient(connection);

  async function query<R = Record<string, unknown>>(request: QueryRequest): Promise<QueryResult<R>> {
    const started = Date.now();
    try {
      const result = await withTimeout(
        client.execute({ sql: request.sql, args: toLibsqlParams(request.params ?? []) }),
        request.timeoutMs ?? defaultTimeoutMs,
        { provider: 'turso' },
      );

      const rows = result.rows.map((row) => {
        const record: Record<string, unknown> = {};
        result.columns.forEach((column, index) => {
          record[column] = row[index];
        });
        return record as R;
      });

      return { rows, rowCount: rows.length, durationMs: Date.now() - started };
    } catch (cause) {
      if (InfraError.is(cause)) throw cause;
      throw new InfraError('DB_QUERY_FAILED', 'tenant query failed', {
        cause,
        details: { provider: 'turso', durationMs: Date.now() - started },
      });
    }
  }

  async function health(): Promise<HealthReport> {
    const started = Date.now();
    try {
      await withTimeout(client.execute('select 1'), defaultTimeoutMs, { provider: 'turso' });
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
    client.close();
  }

  return { dialect: 'libsql', provider: 'turso', query, health, close };
}
