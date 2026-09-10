import { classifyLatency, type DatabaseAdapter, type HealthReport, type HealthStatus } from './types.js';

export interface HealthCheckOptions {
  timeoutMs?: number;
  now?: () => number;
}

/** Wraps adapter.health() so a thrown driver error becomes a report, never an exception. */
export async function checkAdapterHealth(
  adapter: DatabaseAdapter,
  options: HealthCheckOptions = {},
): Promise<HealthReport> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  try {
    return await adapter.health();
  } catch (cause) {
    return {
      status: 'down',
      latencyMs: now() - started,
      checkedAt: new Date(),
      error: cause instanceof Error ? cause.message : 'unknown error',
    };
  }
}

export interface AppHealthReport extends HealthReport {
  appId: string;
  configId: string;
}

/** Checks many apps at once, tolerating individual failures. */
export async function checkManyApps(
  targets: ReadonlyArray<{ appId: string; configId: string; adapter: DatabaseAdapter }>,
): Promise<AppHealthReport[]> {
  return Promise.all(
    targets.map(async (target) => ({
      appId: target.appId,
      configId: target.configId,
      ...(await checkAdapterHealth(target.adapter)),
    })),
  );
}

export function worstStatus(reports: readonly HealthReport[]): HealthStatus {
  if (reports.some((report) => report.status === 'down')) return 'down';
  if (reports.some((report) => report.status === 'degraded')) return 'degraded';
  return 'healthy';
}

export { classifyLatency };
