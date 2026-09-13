/**
 * GET /api/v1/me — the signed-in user, scoped to the app that owns the API key.
 *
 * Cross-domain, so there is no cookie to read: the caller sends the user's access token in
 * `x-infra-access-token` while `Authorization` carries the app's API key. A token minted for
 * another app is rejected by the `aud` check inside verifyToken.
 */
import { bearerFromHeader, verifyToken } from '@infra/auth';
import { getMembership } from '@infra/db';
import { db } from '@/lib/db';
import { corsHeaders, preflightResponse } from '@/lib/cors';
import { requireApiKey } from '@/lib/guard';
import { tokenIssuer } from '@/lib/issuer';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request: Request): Promise<Response> {
  return preflightResponse(request.headers.get('origin'), [request.headers.get('origin') ?? '']);
}

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const origin = request.headers.get('origin');

  try {
    const caller = await requireApiKey(request, 'auth:read');
    const cors = corsHeaders(origin, caller.app.allowedOrigins);

    const header = request.headers.get('x-infra-access-token');
    const accessToken = header === null ? null : bearerFromHeader(header) ?? header.trim();

    // No user token is not an error — it simply means nobody is signed in on this client.
    if (accessToken === null || accessToken === '') {
      const empty = jsonOk(null, requestId);
      for (const [key, value] of Object.entries(cors)) empty.headers.set(key, value);
      return empty;
    }

    const claims = await verifyToken(db(), accessToken, {
      issuer: tokenIssuer(),
      audience: caller.appId,
      expectedType: 'access',
    });

    const membership = await getMembership(db(), caller.appId, claims.sub);
    const payload =
      membership === null
        ? null
        : {
            user: { id: claims.sub },
            appId: caller.appId,
            roles: claims.roles,
            workspaceId: claims.wid,
            sessionId: claims.sid,
            expiresAt: new Date(claims.exp * 1000).toISOString(),
          };

    const response = jsonOk(payload, requestId);
    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
    return response;
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
