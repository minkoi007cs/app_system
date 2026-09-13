/**
 * Access token issuance and verification, wired to the Master DB.
 *
 * This is the layer route handlers talk to; @infra/core/jwt stays pure and testable, and this
 * module owns the stateful parts: which key is active, and caching the public keys.
 */
import type { JsonWebKey } from 'node:crypto';
import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  InfraError,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
  type ActorClaim,
  type SignedToken,
  type TokenType,
} from '@infra/core';
import { getActiveSigningKey, listPublicSigningKeys, type MasterDatabase } from '@infra/db';

export interface IssueTokenInput {
  /** user id, or a service account id prefixed `svc_`. */
  subject: string;
  /** Always the app the credential belongs to — never a value supplied by the client. */
  appId: string;
  sessionId: string;
  scope?: readonly string[];
  roles?: readonly string[];
  workspaceId?: string | null;
  actor?: ActorClaim | null;
  amr?: readonly string[];
  type?: TokenType;
  ttlSeconds?: number;
}

export interface TokenIssuerOptions {
  issuer: string;
  /** Injectable clock for tests, in seconds. */
  now?: () => number;
}

export async function issueAccessToken(
  db: MasterDatabase,
  input: IssueTokenInput,
  options: TokenIssuerOptions,
): Promise<SignedToken> {
  if (input.appId === '') throw new InfraError('VALIDATION_FAILED', 'appId is required to issue a token');

  const key = await getActiveSigningKey(db);

  return signAccessToken(
    {
      issuer: options.issuer,
      subject: input.subject,
      audience: input.appId,
      sessionId: input.sessionId,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.roles === undefined ? {} : { roles: input.roles }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.amr === undefined ? {} : { amr: input.amr }),
      ...(input.type === undefined ? {} : { type: input.type }),
      ttlSeconds: input.ttlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    },
    { key, ...(options.now === undefined ? {} : { now: options.now }) },
  );
}

// ── public key cache ─────────────────────────────────────────────────────────

const JWKS_CACHE_TTL_MS = 30_000;

interface JwksCache {
  keys: Map<string, JsonWebKey>;
  loadedAt: number;
}

interface CacheGlobal {
  __infraJwksCache?: JwksCache;
}

const cacheGlobal = globalThis as unknown as CacheGlobal;

/**
 * Verification runs on every request, so the public keys are cached briefly.
 * A cache miss on an unknown kid forces a reload, so a freshly rotated key is picked up at once.
 */
export async function loadPublicKeys(db: MasterDatabase, force = false): Promise<Map<string, JsonWebKey>> {
  const cached = cacheGlobal.__infraJwksCache;
  if (!force && cached !== undefined && Date.now() - cached.loadedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }

  const rows = await listPublicSigningKeys(db);
  const keys = new Map<string, JsonWebKey>(rows.map((row) => [row.kid, row.jwk as JsonWebKey]));
  cacheGlobal.__infraJwksCache = { keys, loadedAt: Date.now() };
  return keys;
}

export function clearPublicKeyCache(): void {
  delete cacheGlobal.__infraJwksCache;
}

export interface VerifyTokenOptions extends TokenIssuerOptions {
  /** The app the endpoint is serving. Leave undefined only for app-agnostic endpoints. */
  audience?: string;
  expectedType?: TokenType;
  requiredScopes?: readonly string[];
}

export async function verifyToken(
  db: MasterDatabase,
  token: string,
  options: VerifyTokenOptions,
): Promise<AccessTokenClaims> {
  const attempt = async (force: boolean): Promise<AccessTokenClaims> => {
    const publicKeys = await loadPublicKeys(db, force);
    return verifyAccessToken(token, {
      publicKeys,
      issuer: options.issuer,
      ...(options.audience === undefined ? {} : { audience: options.audience }),
      ...(options.expectedType === undefined ? {} : { expectedType: options.expectedType }),
      ...(options.requiredScopes === undefined ? {} : { requiredScopes: options.requiredScopes }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  };

  try {
    return await attempt(false);
  } catch (error) {
    // An unknown kid usually means "rotated since we last looked" — reload once, then give up.
    if (InfraError.is(error) && error.message.includes('unknown signing key')) {
      return attempt(true);
    }
    throw error;
  }
}

/** Extracts a bearer token from an Authorization header. */
export function bearerFromHeader(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
