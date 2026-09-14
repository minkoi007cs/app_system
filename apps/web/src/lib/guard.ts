/**
 * API key guard for /api/v1/*.
 *
 * appId ALWAYS comes from the verified key — never from the request body or a header, so a child
 * app cannot ask for another app's database.
 *
 * Two kinds of key, enforced here:
 *   sk_  secret       — anything, including raw SQL. Refused outright if the request looks like it
 *                       came from a browser, because that means the key has been shipped to clients.
 *   pk_  publishable   — safe in a browser bundle; refused by endpoints that bypass the rules engine.
 */
import {
  apiKeyFromAuthorizationHeader,
  hasScope,
  InfraError,
  looksLikeBrowserRequest,
  type ApiKeyKind,
  type ApiKeyScope,
} from '@infra/core';
import {
  assertServiceAccountUsable,
  touchApiKeyUsage,
  verifyApiKey,
  type InfraApiKeyRow,
  type InfraAppRow,
} from '@infra/db';
import { db } from './db';
import { consume } from './rate-limit';

export interface AuthenticatedCaller {
  key: InfraApiKeyRow;
  app: InfraAppRow;
  appId: string;
  kind: ApiKeyKind;
  /** Set when the key speaks for a machine identity rather than a person. */
  serviceAccountId: string | null;
}

export interface GuardOptions {
  /** Which key kinds this endpoint accepts. Defaults to both. */
  kinds?: readonly ApiKeyKind[];
}

export async function requireApiKey(
  request: Request,
  scope: ApiKeyScope,
  options: GuardOptions = {},
): Promise<AuthenticatedCaller> {
  const rawKey = apiKeyFromAuthorizationHeader(request.headers.get('authorization'));
  if (rawKey === null) {
    throw new InfraError('UNAUTHENTICATED', 'missing Authorization: Bearer <api key> header');
  }

  const { key, app } = await verifyApiKey(db(), rawKey);
  const kind = key.keyType;

  const accepted = options.kinds ?? ['publishable', 'secret'];
  if (!accepted.includes(kind)) {
    throw new InfraError(
      'FORBIDDEN_SCOPE',
      kind === 'publishable'
        ? 'this endpoint requires a secret key (sk_…); a publishable key cannot bypass the rules engine'
        : 'this endpoint does not accept secret keys',
      { details: { required: accepted } },
    );
  }

  // A secret key arriving with an Origin/Referer has been shipped to a browser — treat as burned.
  if (
    kind === 'secret' &&
    looksLikeBrowserRequest(request.headers.get('origin'), request.headers.get('referer'))
  ) {
    throw new InfraError(
      'FORBIDDEN_SCOPE',
      'a secret key was sent from a browser — rotate it immediately and keep sk_ keys server-side',
      { details: { keyPrefix: key.keyPrefix, action: 'rotate_now' } },
    );
  }

  if (!hasScope(key.scopes, scope)) {
    throw new InfraError('FORBIDDEN_SCOPE', `this API key is missing the ${scope} scope`, {
      details: { required: scope },
    });
  }

  const verdict = await consume(key.id);
  if (!verdict.allowed) {
    throw new InfraError('RATE_LIMITED', 'too many requests for this API key', {
      details: { retryInMs: verdict.resetInMs },
    });
  }

  // A machine identity carries extra conditions its owner set: status and an IP allowlist.
  if (key.serviceAccountId !== null) {
    await assertServiceAccountUsable(db(), key.serviceAccountId, clientIp(request));
  }

  void touchApiKeyUsage(db(), key.id).catch(() => {});

  return { key, app, appId: app.id, kind, serviceAccountId: key.serviceAccountId };
}

export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null) return forwarded.split(',')[0]?.trim() ?? null;
  return request.headers.get('x-real-ip');
}

export function userAgent(request: Request): string | null {
  return request.headers.get('user-agent');
}
