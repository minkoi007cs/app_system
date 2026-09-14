/**
 * /api/v1/webhooks — a child app manages its own endpoints.
 *
 * GET  lists them, without ever returning a signing secret.
 * POST registers one and returns the secret exactly once, the same contract as an API key.
 *
 * Secret-key only: a publishable key is shipped to browsers, and anyone holding one could
 * otherwise point the app's identity events at a server they control.
 */
import { InfraError, isWebhookEventType, type WebhookEventType } from '@infra/core';
import { createWebhookEndpoint, listWebhookEndpoints, recordAuditAsync } from '@infra/db';
import { db } from '@/lib/db';
import { clientIp, requireApiKey, userAgent } from '@/lib/guard';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CreateBody {
  url?: unknown;
  description?: unknown;
  event_types?: unknown;
}

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();

  try {
    const caller = await requireApiKey(request, 'auth:read', { kinds: ['secret'] });
    const endpoints = await listWebhookEndpoints(db(), caller.appId);

    return jsonOk(
      endpoints.map((endpoint) => ({
        id: endpoint.id,
        url: endpoint.url,
        description: endpoint.description,
        event_types: endpoint.eventTypes,
        status: endpoint.status,
        consecutive_failures: endpoint.consecutiveFailures,
        last_success_at: endpoint.lastSuccessAt,
        created_at: endpoint.createdAt,
      })),
      requestId,
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();

  try {
    // 'admin', not a data scope: registering where identity events go is an administrative act.
    const caller = await requireApiKey(request, 'admin', { kinds: ['secret'] });
    const body = (await request.json().catch(() => ({}))) as CreateBody;

    if (typeof body.url !== 'string' || body.url === '') {
      throw new InfraError('VALIDATION_FAILED', 'url is required');
    }

    let eventTypes: WebhookEventType[] = [];
    if (Array.isArray(body.event_types)) {
      const requested = body.event_types.filter((value): value is string => typeof value === 'string');
      const unknown = requested.filter((value) => !isWebhookEventType(value));
      if (unknown.length > 0) {
        throw new InfraError('VALIDATION_FAILED', 'unknown event type', { details: { unknown } });
      }
      eventTypes = requested.filter(isWebhookEventType);
    }

    const created = await createWebhookEndpoint(db(), {
      appId: caller.appId,
      url: body.url,
      description: typeof body.description === 'string' ? body.description : null,
      eventTypes,
    });

    recordAuditAsync(db(), {
      appId: caller.appId,
      actorType: 'api_key',
      actorId: caller.key.id,
      action: 'webhook.endpoint.created',
      targetType: 'webhook_endpoint',
      targetId: created.row.id,
      ipAddress: clientIp(request),
      userAgent: userAgent(request),
      meta: { eventTypes },
    });

    return jsonOk(
      {
        id: created.row.id,
        url: created.row.url,
        event_types: created.row.eventTypes,
        status: created.row.status,
        // Shown exactly once. Store it; it cannot be read back, only rotated.
        signing_secret: created.secret,
      },
      requestId,
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
