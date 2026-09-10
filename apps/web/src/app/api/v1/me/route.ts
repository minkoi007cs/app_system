/**
 * GET /api/v1/me — the signed-in user, scoped to the app that owns the API key.
 * A session from another app resolves to null rather than leaking a foreign identity.
 */
import { auth, getMembership } from '@infra/auth';
import { db } from '@/lib/db';
import { requireApiKey } from '@/lib/guard';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();

  try {
    const caller = await requireApiKey(request, 'auth:read');
    const session = await auth().api.getSession({ headers: request.headers });

    if (session === null) return jsonOk(null, requestId);

    const membership = await getMembership(db(), caller.appId, session.user.id);
    if (membership === null) return jsonOk(null, requestId);

    return jsonOk(
      {
        user: {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          image: session.user.image ?? null,
          emailVerified: session.user.emailVerified,
        },
        appId: caller.appId,
        expiresAt: session.session.expiresAt.toISOString(),
      },
      requestId,
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
