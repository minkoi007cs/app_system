/**
 * GET /.well-known/jwks.json (rewritten to /api/jwks)
 *
 * The public half of every signing key a verifier should still trust. Public by design —
 * child apps and any standards-compliant JWT library fetch it to check our tokens offline.
 */
import { listPublicSigningKeys, provisionSigningKey } from '@infra/db';
import { db } from '@/lib/db';
import { newRequestId, toErrorResponse } from '@/lib/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const requestId = newRequestId();

  try {
    let keys = await listPublicSigningKeys(db());

    // A fresh install has no key yet; create one on first fetch so nothing has to be seeded by hand.
    if (keys.length === 0) {
      await provisionSigningKey(db());
      keys = await listPublicSigningKeys(db());
    }

    return Response.json(
      { keys: keys.map((key) => key.jwk) },
      {
        headers: {
          'x-request-id': requestId,
          // Short enough that a rotation propagates quickly, long enough to not hammer the DB.
          'cache-control': 'public, max-age=300, stale-while-revalidate=600',
          'content-type': 'application/jwk-set+json',
        },
      },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
