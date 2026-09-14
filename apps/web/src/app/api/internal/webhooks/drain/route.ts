/**
 * POST /api/internal/webhooks/drain — send whatever deliveries are due.
 *
 * Meant to be called on a schedule (cron, a platform scheduler, or a loop in a worker). It is not
 * part of the public API and it is not reachable with a tenant key: it takes the platform's own
 * shared secret, compared in constant time, because an open drain endpoint is a way to make the
 * platform emit traffic on demand.
 */
import { timingSafeEqual } from 'node:crypto';
import { InfraError } from '@infra/core';
import { drainWebhookQueue } from '@/lib/webhook-dispatch';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.INFRA_INTERNAL_TOKEN ?? '';
  if (expected === '') return false;

  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();

  try {
    if (!authorised(request)) {
      throw new InfraError('UNAUTHENTICATED', 'internal endpoint requires the platform token');
    }

    const result = await drainWebhookQueue();
    return jsonOk(result, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
