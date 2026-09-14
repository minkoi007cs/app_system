/**
 * POST /api/v1/auth/recovery/request — start a password recovery.
 *
 * Answers 202 with the same body whether or not the address has an account. That is not politeness:
 * an endpoint that answers differently is a free list of every registered user, and it is reachable
 * without a password. For the same reason the answer is padded to a constant duration, and the
 * token never appears in the response.
 *
 * Throttled per IP so the endpoint cannot be turned into a mail cannon aimed at someone's inbox.
 */
import { auth, requestPasswordRecovery } from '@infra/auth';
import { parseServerEnv, remainingFloorMs, sleep } from '@infra/core';
import { checkLoginThrottle, recordAuditAsync, recordLoginFailure } from '@infra/db';
import { db } from '@/lib/db';
import { clientIp, userAgent } from '@/lib/guard';
import { deliverRecoveryLink, recoveryUrl } from '@/lib/recovery-delivery';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RequestBody {
  email?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const startedAt = Date.now();
  const ip = clientIp(request);

  try {
    const body = (await request.json().catch(() => ({}))) as RequestBody;
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    // Keyed on IP alone: keying on the email would let anyone lock a known victim out of recovery.
    const verdict = await checkLoginThrottle(db(), { ip, email: null });
    if (!verdict.allowed) {
      await sleep(remainingFloorMs(Date.now() - startedAt));
      return jsonOk({ status: 'accepted' }, requestId, { status: 202 });
    }

    if (email !== '') {
      const result = await requestPasswordRecovery(auth(), db(), { email, ip });

      if (result.issued && result.token !== null) {
        const env = parseServerEnv();
        deliverRecoveryLink({ email, url: recoveryUrl(env.INFRA_PUBLIC_URL, result.token) });
      }

      recordAuditAsync(db(), {
        actorType: 'system',
        actorId: result.userId,
        action: 'auth.recovery.requested',
        // Success either way in the log too — the audit trail is read by people who should not be
        // able to use it as an enumeration oracle either.
        outcome: 'success',
        ipAddress: ip,
        userAgent: userAgent(request),
        meta: { delivered: result.issued },
      });

      if (!result.issued) await recordLoginFailure(db(), { ip, email: null });
    }

    await sleep(remainingFloorMs(Date.now() - startedAt));
    return jsonOk({ status: 'accepted' }, requestId, { status: 202 });
  } catch (error) {
    await sleep(remainingFloorMs(Date.now() - startedAt));
    return toErrorResponse(error, requestId);
  }
}
