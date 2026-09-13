/**
 * The contract every tenant database must satisfy.
 * Adding a provider means adding one adapter file — no route handler ever changes.
 */

export type SqlDialect = 'postgres' | 'libsql';
export type DbProvider = 'neon' | 'supabase' | 'turso';
export type HealthStatus = 'healthy' | 'degraded' | 'down';

export const DIALECT_BY_PROVIDER: Readonly<Record<DbProvider, SqlDialect>> = {
  neon: 'postgres',
  supabase: 'postgres',
  turso: 'libsql',
};

export interface QueryRequest {
  /** Static SQL written by the child app. Values NEVER go in here. */
  sql: string;
  /** Bound parameters — the only way values reach the database. */
  params?: readonly unknown[];
  timeoutMs?: number;
}

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
  durationMs: number;
}

export interface HealthReport {
  status: HealthStatus;
  latencyMs: number | null;
  checkedAt: Date;
  error?: string;
}

export interface DatabaseAdapter {
  readonly dialect: SqlDialect;
  readonly provider: DbProvider;
  query<R = Record<string, unknown>>(request: QueryRequest): Promise<QueryResult<R>>;
  health(): Promise<HealthReport>;
  close(): Promise<void>;
}

export interface AdapterConfig {
  provider: DbProvider;
  /** Plaintext DSN — lives in memory only, never logged or serialised. */
  connectionString: string;
  poolMax?: number;
  defaultTimeoutMs?: number;
}

export const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
export const DEFAULT_POOL_MAX = 3;

/**
 * < 300ms healthy, anything slower but still answering is degraded.
 *
 * 'down' is reserved for a database that did NOT answer (error or timeout). Free-tier
 * databases sleep when idle, so the first query after a pause can take seconds — slow
 * is not the same as unreachable, and reporting it as down cries wolf.
 */
export const HEALTH_THRESHOLDS = { healthyMs: 300, degradedMs: 1500 } as const;

export function classifyLatency(latencyMs: number): HealthStatus {
  return latencyMs < HEALTH_THRESHOLDS.healthyMs ? 'healthy' : 'degraded';
}

/** True when a cold start is the likely explanation for a slow-but-successful ping. */
export function looksLikeColdStart(latencyMs: number): boolean {
  return latencyMs >= HEALTH_THRESHOLDS.degradedMs;
}
