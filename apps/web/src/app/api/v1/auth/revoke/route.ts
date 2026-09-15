/**
 * POST /api/v1/auth/revoke — sign out.
 *
 *   { refreshToken }        → ends that one session
 *   { sessionId }           → ends that session (for a device list "sign out this device")
 *   { allSessions: true }   → ends every session of the user carrying the access token
 */
import { bearerFromHeader, verifyToken } from '@infra/auth';
import { InfraError } from '@infra/core';
import { findRefreshTokenByHash, recordAuditAsync, revokeAllForUser, revokeSession } from '@infra/db';
import { db } from '@/lib/db';
import { corsHeaders, preflightResponse } from '@/lib/cors';
import { clientIp, requireApiKey } from '@/lib/guard';
import { tokenIssuer } from '@/lib/issuer';
import { booleanField, stringField } from '@/lib/body-fields';
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
    // Mọi trường nhận cả camelCase và snake_case — xem lib/body-fields.
    const body: unknown = await request.json().catch(() => ({}));
    const refreshToken = stringField(body, 'refreshToken');
    const sessionId = stringField(body, 'sessionId');

    let revoked = 0;

    if (refreshToken !== null) {
      // Looked up by hash — the raw value is never compared or logged.
      const match = await findRefreshTokenByHash(db(), refreshToken);
      revoked = match === null ? 0 : await revokeSession(db(), match.sessionId, 'logout');
    } else if (sessionId !== null) {
      revoked = await revokeSession(db(), sessionId, 'logout');
    } else if (booleanField(body, 'allSessions')) {
      const accessToken =
        stringField(body, 'accessToken') ??
        bearerFromHeader(request.headers.get('x-infra-access-token'));
      if (accessToken === null) {
        throw new InfraError('VALIDATION_FAILED', 'allSessions requires the user access token');
      }
      const claims = await verifyToken(db(), accessToken, {
        issuer: tokenIssuer(),
        audience: caller.appId,
        expectedType: 'access',
      });
      revoked = await revokeAllForUser(db(), claims.sub, 'logout');
    } else {
      throw new InfraError('VALIDATION_FAILED', 'provide refreshToken, sessionId or allSessions');
    }

    recordAuditAsync(db(), {
      appId: caller.appId,
      actorType: 'api_key',
      actorId: caller.key.id,
      action: 'auth.token.revoked',
      ipAddress: clientIp(request),
      meta: { revoked, requestId },
    });

    const response = jsonOk({ revoked }, requestId);
    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
    return response;
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
