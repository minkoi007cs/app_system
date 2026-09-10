/**
 * API key guard for /api/v1/*.
 *
 * appId ALWAYS comes from the verified key — never from the request body or a header,
 * so a child app cannot ask for another app's database.
 */
import { apiKeyFromAuthorizationHeader, hasScope, InfraError, type ApiKeyScope } from '@infra/core';
import { touchApiKeyUsage, verifyApiKey, type InfraApiKeyRow, type InfraAppRow } from '@infra/db';
import { db } from './db';
import { consume } from './rate-limit';

export interface AuthenticatedCaller {
  key: InfraApiKeyRow;
  app: InfraAppRow;
  appId: string;
}

export async function requireApiKey(request: Request, scope: ApiKeyScope): Promise<AuthenticatedCaller> {
  const rawKey = apiKeyFromAuthorizationHeader(request.headers.get('authorization'));
  if (rawKey === null) {
    throw new InfraError('UNAUTHENTICATED', 'missing Authorization: Bearer pk_live_… header');
  }

  const { key, app } = await verifyApiKey(db(), rawKey);

  if (!hasScope(key.scopes, scope)) {
    throw new InfraError('FORBIDDEN_SCOPE', `this API key is missing the ${scope} scope`, {
      details: { required: scope },
    });
  }

  const verdict = consume(key.id);
  if (!verdict.allowed) {
    throw new InfraError('RATE_LIMITED', 'too many requests for this API key', {
      details: { retryInMs: verdict.resetInMs },
    });
  }

  // Usage stamp must never delay or fail the request.
  void touchApiKeyUsage(db(), key.id).catch(() => {});

  return { key, app, appId: app.id };
}

export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null) return forwarded.split(',')[0]?.trim() ?? null;
  return request.headers.get('x-real-ip');
}
