/**
 * POST /api/v1/auth/refresh — rotate a refresh token into a fresh pair.
 *
 * Presenting a token that was already used revokes the entire family: that pattern means a copy
 * of the token exists somewhere it should not.
 */
import { rotateTokenPair } from '@infra/auth';
import { InfraError } from '@infra/core';
import { recordAuditAsync } from '@infra/db';
import { db } from '@/lib/db';
import { corsHeaders, preflightResponse } from '@/lib/cors';
import { clientIp, requireApiKey, userAgent } from '@/lib/guard';
import { tokenIssuer } from '@/lib/issuer';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request: Request): Promise<Response> {
  return preflightResponse(request.headers.get('origin'), [request.headers.get('origin') ?? '']);
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const origin = request.headers.get('origin');

  try {
    const caller = await requireApiKey(request, 'auth:read');
    const cors = corsHeaders(origin, caller.app.allowedOrigins);

    const body = (await request.json().catch(() => ({}))) as { refreshToken?: unknown };
    if (typeof body.refreshToken !== 'string' || body.refreshToken === '') {
      throw new InfraError('VALIDATION_FAILED', 'refreshToken is required');
    }

    try {
      const pair = await rotateTokenPair(
        db(),
        body.refreshToken,
        { issuer: tokenIssuer() },
        { userAgent: userAgent(request), ipAddress: clientIp(request) },
      );

      recordAuditAsync(db(), {
        appId: caller.appId,
        actorType: 'api_key',
        actorId: caller.key.id,
        action: 'auth.token.refreshed',
        ipAddress: clientIp(request),
        meta: { sessionId: pair.sessionId, requestId },
      });

      const response = jsonOk(pair, requestId);
      for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
      return response;
    } catch (error) {
      if (InfraError.is(error) && error.details['reuseDetected'] === true) {
        recordAuditAsync(db(), {
          appId: caller.appId,
          actorType: 'api_key',
          actorId: caller.key.id,
          action: 'auth.token.reuse_detected',
          outcome: 'failure',
          ipAddress: clientIp(request),
          userAgent: userAgent(request),
          meta: {
            familyId: error.details['familyId'],
            revokedCount: error.details['revokedCount'],
            requestId,
          },
        });
      }
      throw error;
    }
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
