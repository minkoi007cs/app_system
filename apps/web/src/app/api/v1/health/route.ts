/** GET /api/v1/health — pings the calling app's tenant database. */
import { recordHealth } from '@infra/db';
import { getPrimaryDatabaseConfig } from '@infra/db';
import { db } from '@/lib/db';
import { requireApiKey } from '@/lib/guard';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';
import { resolver } from '@/lib/resolver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();

  try {
    const caller = await requireApiKey(request, 'db:read');
    const adapter = await resolver().resolve(caller.appId);
    const report = await adapter.health();

    const config = await getPrimaryDatabaseConfig(db(), caller.appId);
    if (config !== null) {
      void recordHealth(db(), config.id, report.status, report.latencyMs).catch(() => {});
    }

    return jsonOk(
      {
        status: report.status,
        latencyMs: report.latencyMs,
        checkedAt: report.checkedAt.toISOString(),
        provider: adapter.provider,
      },
      requestId,
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
