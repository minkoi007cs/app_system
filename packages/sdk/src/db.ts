import { request } from './http.js';
import type { HealthReport, InfraClientOptions, InfraDbClient, Result } from './types.js';

export function createDbClient(options: InfraClientOptions): InfraDbClient {
  return {
    async query<R = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<Result<R[]>> {
      return request<R[]>(options, {
        method: 'POST',
        path: '/api/v1/query',
        body: { sql, params },
        useApiKey: true,
      });
    },

    async queryOne<R = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<Result<R | null>> {
      const result = await request<R[]>(options, {
        method: 'POST',
        path: '/api/v1/query',
        body: { sql, params },
        useApiKey: true,
      });
      if (result.error !== null) return { data: null, error: result.error };
      return { data: result.data[0] ?? null, error: null };
    },

    async health(): Promise<Result<HealthReport>> {
      return request<HealthReport>(options, { method: 'GET', path: '/api/v1/health', useApiKey: true });
    },
  };
}
