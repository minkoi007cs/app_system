/**
 * POST /api/v1/auth/token — exchange user credentials for an access + refresh token pair.
 *
 * The app is identified by the API key in the Authorization header (publishable is fine here);
 * the user is identified by the credentials in the body. `aud` on the resulting token always
 * comes from the key, never from the body.
 */
import { randomUUID } from 'node:crypto';
import { auth, issueAccessToken, issueTokenPair } from '@infra/auth';
import { InfraError } from '@infra/core';
import { addMember, assignDefaultRole, getMembership, recordAuditAsync } from '@infra/db';
import { stringField } from '@/lib/body-fields';
import { db } from '@/lib/db';
import { corsHeaders, preflightResponse } from '@/lib/cors';
import { clientIp, requireApiKey, userAgent } from '@/lib/guard';
import { tokenIssuer } from '@/lib/issuer';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request: Request): Promise<Response> {
  // Preflight happens before authentication, so the allowlist cannot be app-specific yet;
  // the actual POST re-checks the origin against the app that owns the key.
  return preflightResponse(request.headers.get('origin'), [request.headers.get('origin') ?? '']);
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const origin = request.headers.get('origin');

  try {
    const caller = await requireApiKey(request, 'auth:read');
    const cors = corsHeaders(origin, caller.app.allowedOrigins);

    // A browser call must come from an origin this app registered.
    if (origin !== null && origin !== '' && !caller.app.allowedOrigins.includes(origin)) {
      throw new InfraError('FORBIDDEN_SCOPE', 'origin is not registered for this application', {
        details: { origin },
      });
    }

    const body: unknown = await request.json().catch(() => ({}));
    // `grant_type` (OAuth) và `grantType` (quy ước của API này) đều được nhận — xem lib/body-fields.
    const grantType = stringField(body, 'grantType') ?? 'password';

    // ── machine identity: no user, no refresh token, short life ──────────────
    if (grantType === 'client_credentials') {
      if (caller.serviceAccountId === null) {
        throw new InfraError(
          'FORBIDDEN_SCOPE',
          'client_credentials requires a key that belongs to a service account',
        );
      }

      const machineToken = await issueAccessToken(
        db(),
        {
          subject: `svc_${caller.serviceAccountId}`,
          appId: caller.appId,
          sessionId: `svc_${caller.key.id}`,
          scope: caller.key.scopes,
          roles: ['service_account'],
          amr: ['api_key'],
          // Machines re-request rather than refresh: a refresh token is a long-lived
          // credential no process needs when it already holds the key that minted this one.
          ttlSeconds: 900,
        },
        { issuer: tokenIssuer() },
      );

      recordAuditAsync(db(), {
        appId: caller.appId,
        actorType: 'api_key',
        actorId: caller.key.id,
        action: 'auth.token.issued',
        targetType: 'service_account',
        targetId: caller.serviceAccountId,
        ipAddress: clientIp(request),
        meta: { grant: 'client_credentials', requestId },
      });

      const machineResponse = jsonOk(
        {
          tokenType: 'Bearer',
          accessToken: machineToken.token,
          expiresIn: machineToken.claims.exp - machineToken.claims.iat,
          expiresAt: machineToken.expiresAt.toISOString(),
        },
        requestId,
      );
      for (const [key, value] of Object.entries(cors)) machineResponse.headers.set(key, value);
      return machineResponse;
    }

    if (grantType !== 'password') {
      throw new InfraError('VALIDATION_FAILED', `unsupported grant_type: ${grantType}`);
    }
    const email = stringField(body, 'email');
    const password = stringField(body, 'password');
    if (email === null || password === null) {
      throw new InfraError('VALIDATION_FAILED', 'email and password are required');
    }

    let userId: string;
    try {
      const result = await auth().api.signInEmail({
        body: { email, password },
      });
      userId = result.user.id;
    } catch {
      recordAuditAsync(db(), {
        appId: caller.appId,
        actorType: 'api_key',
        actorId: caller.key.id,
        action: 'auth.signin.failed',
        outcome: 'failure',
        ipAddress: clientIp(request),
        meta: { requestId },
      });
      // Deliberately identical whether the email is unknown or the password is wrong.
      throw new InfraError('UNAUTHENTICATED', 'invalid email or password');
    }

    // B2C: a user signing into an app for the first time becomes a member of that app.
    let membership = await getMembership(db(), caller.appId, userId);
    const isNewMember = membership === null;
    membership ??= await addMember(db(), caller.appId, userId, 'member');

    // Membership is not permission. `infra_app_members` records that a person belongs here;
    // RBAC reads what they may do from `infra_role_assignments`, and nothing was writing to it.
    // So a new account could sign in, hold a valid token, and be refused everything — correct
    // behaviour, indistinguishable from a broken product.
    //
    // Granting the app's default role closes that. An app that wants the opposite — access only
    // by invitation — clears `default_role_key` and this becomes a no-op. Idempotent either way,
    // so a returning member costs one insert that does nothing; run only for new members so the
    // common path does not pay for it at all.
    if (isNewMember) {
      const granted = await assignDefaultRole(db(), caller.appId, userId);
      if (granted !== null) {
        recordAuditAsync(db(), {
          appId: caller.appId,
          actorType: 'api_key',
          actorId: caller.key.id,
          action: 'access.role_assigned',
          targetType: 'user',
          targetId: userId,
          ipAddress: clientIp(request),
          meta: { role: granted, via: 'default_role', requestId },
        });
      }
    }

    const sessionId = `sess_${randomUUID().replace(/-/g, '')}`;
    const pair = await issueTokenPair(
      db(),
      {
        userId,
        appId: caller.appId,
        sessionId,
        scope: ['db:read', 'auth:read'],
        roles: [membership.role],
        amr: ['pwd'],
        userAgent: userAgent(request),
        ipAddress: clientIp(request),
      },
      { issuer: tokenIssuer() },
    );

    recordAuditAsync(db(), {
      appId: caller.appId,
      actorType: 'api_key',
      actorId: caller.key.id,
      action: 'auth.token.issued',
      targetType: 'user',
      targetId: userId,
      ipAddress: clientIp(request),
      userAgent: userAgent(request),
      meta: { sessionId, requestId, keyType: caller.kind },
    });

    const response = jsonOk(pair, requestId);
    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
    return response;
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
