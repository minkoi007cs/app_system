import type { DatabaseAdapter, HealthReport, QueryRequest, QueryResult } from '../src/index.js';

export interface FakeAdapter extends DatabaseAdapter {
  readonly closed: () => boolean;
  readonly queries: QueryRequest[];
}

export function createFakeAdapter(options: { latencyMs?: number; failHealth?: boolean } = {}): FakeAdapter {
  let closed = false;
  const queries: QueryRequest[] = [];

  return {
    dialect: 'postgres',
    provider: 'neon',
    queries,
    closed: () => closed,
    async query<R = Record<string, unknown>>(request: QueryRequest): Promise<QueryResult<R>> {
      queries.push(request);
      return { rows: [] as R[], rowCount: 0, durationMs: 1 };
    },
    async health(): Promise<HealthReport> {
      if (options.failHealth === true) throw new Error('connection refused');
      const latencyMs = options.latencyMs ?? 10;
      return {
        status: latencyMs < 300 ? 'healthy' : latencyMs < 1500 ? 'degraded' : 'down',
        latencyMs,
        checkedAt: new Date(),
      };
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}
