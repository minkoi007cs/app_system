/**
 * POST /api/internal/webhooks/drain — send whatever deliveries are due.
 *
 * Meant to be called on a schedule (cron, a platform scheduler, or a loop in a worker). It is not
 * part of the public API and it is not reachable with a tenant key: it takes the platform's own
 * shared secret, compared in constant time, because an open drain endpoint is a way to make the
 * platform emit traffic on demand.
 */
import { drainWebhookQueue } from '@/lib/webhook-dispatch';
import { assertInternalToken } from '@/lib/internal-auth';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();

  try {
    assertInternalToken(request);

    const result = await drainWebhookQueue();
    return jsonOk(result, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
