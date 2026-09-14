/**
 * POST /api/v1/auth/recovery/confirm — redeem a recovery link and set a new password.
 *
 * The ordering, the atomic burn and the revocation sweep all live in @infra/auth's
 * completePasswordRecovery; this route is the HTTP skin around it. It reports what was revoked so
 * the person can see that the sessions they did not recognise are gone.
 */
import { auth, completePasswordRecovery } from '@infra/auth';
import { InfraError, remainingFloorMs, sleep } from '@infra/core';
import { checkLoginThrottle, recordAuditAsync, recordLoginFailure } from '@infra/db';
import { db } from '@/lib/db';
import { clientIp, userAgent } from '@/lib/guard';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ConfirmBody {
  token?: unknown;
  password?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const startedAt = Date.now();
  const ip = clientIp(request);

  try {
    // Guessing a 192-bit token is hopeless, but throttling still caps how fast someone can try.
    const verdict = await checkLoginThrottle(db(), { ip, email: null });
    if (!verdict.allowed) {
      throw new InfraError('RATE_LIMITED', 'too many attempts — try again later', {
        details: { retryAfterMs: verdict.retryAfterMs },
      });
    }

    const body = (await request.json().catch(() => ({}))) as ConfirmBody;
    const token = typeof body.token === 'string' ? body.token : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (token === '' || password === '') {
      throw new InfraError('VALIDATION_FAILED', 'token and password are both required');
    }

    const result = await completePasswordRecovery(auth(), db(), { token, newPassword: password, ip });

    recordAuditAsync(db(), {
      actorType: 'system',
      actorId: result.userId,
      action: 'auth.recovery.completed',
      outcome: 'success',
      ipAddress: ip,
      userAgent: userAgent(request),
      meta: { ...result.revoked, breachCheckPerformed: result.assessment.breachCheckPerformed },
    });

    await sleep(remainingFloorMs(Date.now() - startedAt));
    return jsonOk({ status: 'reset', revoked: result.revoked }, requestId);
  } catch (error) {
    await recordLoginFailure(db(), { ip, email: null });
    recordAuditAsync(db(), {
      actorType: 'system',
      action: 'auth.recovery.failed',
      outcome: 'failure',
      ipAddress: ip,
      userAgent: userAgent(request),
      meta: { reason: InfraError.is(error) ? error.code : 'INTERNAL' },
    });

    await sleep(remainingFloorMs(Date.now() - startedAt));
    return toErrorResponse(error, requestId);
  }
}
