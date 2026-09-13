/**
 * ES256 JSON Web Tokens, implemented directly on node:crypto — no external JWT library.
 *
 * Why hand-rolled: the attack surface of a JWT verifier is small and well understood, and every
 * historical JWT CVE came from a verifier that trusted the token's own header (alg confusion,
 * alg=none, unknown kid). Those checks are enforced here, explicitly, in one readable file.
 *
 * Rules this verifier never bends:
 *   1. `alg` MUST be exactly ES256 — the header never selects the algorithm.
 *   2. `kid` MUST match a key the server already trusts.
 *   3. `exp` is required; `iss` and `aud` are checked against expected values.
 *   4. A token whose `typ` is not what the caller asked for is rejected.
 */
import {
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type JsonWebKey as CryptoJwk,
} from 'node:crypto';
import { InfraError } from './errors.js';

export const JWT_ALGORITHM = 'ES256' as const;
const CURVE = 'P-256';
/** Node needs this so ES256 signatures are raw r||s (JOSE) rather than DER. */
const DSA_ENCODING = 'ieee-p1363' as const;

export type TokenType = 'access' | 'refresh_proof' | 'impersonation';

export interface TokenHeader {
  alg: typeof JWT_ALGORITHM;
  typ: 'JWT';
  kid: string;
}

/** Actor claim for delegation / impersonation (RFC 8693 §4.1). */
export interface ActorClaim {
  sub: string;
  reason?: string;
}

export interface AccessTokenClaims {
  iss: string;
  sub: string;
  /** The app this token is valid for. A token minted for app A must never work on app B. */
  aud: string;
  sid: string;
  typ: TokenType;
  scope: string[];
  roles: string[];
  /** Workspace id — null during the personal-use stage. */
  wid: string | null;
  /** Present only while an admin is impersonating someone. */
  act: ActorClaim | null;
  /** Authentication methods actually used: 'pwd', 'otp', 'webauthn', 'oauth', 'api_key'. */
  amr: string[];
  iat: number;
  exp: number;
  jti: string;
}

export interface SigningKeyMaterial {
  kid: string;
  /** PKCS#8 PEM. Never logged, never serialised — the caller decrypts it just in time. */
  privateKeyPem: string;
}

export interface GeneratedSigningKey extends SigningKeyMaterial {
  publicJwk: CryptoJwk & { kid: string; alg: string; use: string };
}

// ── base64url ────────────────────────────────────────────────────────────────

function encodeBase64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function decodeBase64Url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(JSON.stringify(value));
}

// ── key generation ───────────────────────────────────────────────────────────

/** Fresh P-256 keypair plus the public JWK that goes into /.well-known/jwks.json. */
export function generateSigningKeyPair(): GeneratedSigningKey {
  const kid = `key_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: CURVE });

  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const jwk = publicKey.export({ format: 'jwk' }) as CryptoJwk;

  return {
    kid,
    privateKeyPem,
    publicJwk: { ...jwk, kid, alg: JWT_ALGORITHM, use: 'sig' },
  };
}

// ── signing ──────────────────────────────────────────────────────────────────

export interface SignInput {
  issuer: string;
  subject: string;
  audience: string;
  sessionId: string;
  scope?: readonly string[];
  roles?: readonly string[];
  workspaceId?: string | null;
  actor?: ActorClaim | null;
  amr?: readonly string[];
  type?: TokenType;
  ttlSeconds?: number;
}

export interface SignOptions {
  key: SigningKeyMaterial;
  /** Injectable clock, in seconds, for deterministic tests. */
  now?: () => number;
}

export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 600; // 10 minutes

export interface SignedToken {
  token: string;
  claims: AccessTokenClaims;
  expiresAt: Date;
}

export function signAccessToken(input: SignInput, options: SignOptions): SignedToken {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const issuedAt = now();
  const ttl = input.ttlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;

  const claims: AccessTokenClaims = {
    iss: input.issuer,
    sub: input.subject,
    aud: input.audience,
    sid: input.sessionId,
    typ: input.type ?? 'access',
    scope: [...(input.scope ?? [])],
    roles: [...(input.roles ?? [])],
    wid: input.workspaceId ?? null,
    act: input.actor ?? null,
    amr: [...(input.amr ?? [])],
    iat: issuedAt,
    exp: issuedAt + ttl,
    jti: `tok_${randomUUID().replace(/-/g, '')}`,
  };

  const header: TokenHeader = { alg: JWT_ALGORITHM, typ: 'JWT', kid: options.key.kid };
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;

  let signature: Buffer;
  try {
    signature = sign('sha256', Buffer.from(signingInput), {
      key: options.key.privateKeyPem,
      dsaEncoding: DSA_ENCODING,
    });
  } catch (cause) {
    throw new InfraError('INTERNAL', 'unable to sign access token', { cause });
  }

  return {
    token: `${signingInput}.${encodeBase64Url(signature)}`,
    claims,
    expiresAt: new Date(claims.exp * 1000),
  };
}

// ── verification ─────────────────────────────────────────────────────────────

export interface VerifyOptions {
  /** Trusted public keys by kid. Anything not in here is rejected outright. */
  publicKeys: ReadonlyMap<string, CryptoJwk>;
  issuer: string;
  /** The app this endpoint serves. Omit only for endpoints that are genuinely app-agnostic. */
  audience?: string;
  expectedType?: TokenType;
  requiredScopes?: readonly string[];
  clockToleranceSeconds?: number;
  now?: () => number;
}

function reject(message: string, details: Record<string, unknown> = {}): never {
  // Deliberately uniform: a caller must not be able to probe which check failed.
  throw new InfraError('UNAUTHENTICATED', `invalid access token: ${message}`, { details });
}

export function decodeTokenHeader(token: string): TokenHeader {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] === undefined) reject('malformed');
  try {
    const header = JSON.parse(decodeBase64Url(parts[0]).toString('utf8')) as TokenHeader;
    if (typeof header.kid !== 'string' || header.kid === '') reject('missing kid');
    return header;
  } catch {
    return reject('unreadable header');
  }
}

export function verifyAccessToken(token: string, options: VerifyOptions): AccessTokenClaims {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const tolerance = options.clockToleranceSeconds ?? 30;

  const parts = token.split('.');
  if (parts.length !== 3) reject('malformed');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (encodedHeader === undefined || encodedPayload === undefined || encodedSignature === undefined) {
    reject('malformed');
  }

  let header: TokenHeader;
  let claims: AccessTokenClaims;
  try {
    header = JSON.parse(decodeBase64Url(encodedHeader).toString('utf8')) as TokenHeader;
    claims = JSON.parse(decodeBase64Url(encodedPayload).toString('utf8')) as AccessTokenClaims;
  } catch {
    return reject('unreadable');
  }

  // 1 — the header never gets to choose the algorithm.
  if (header.alg !== JWT_ALGORITHM) reject('unsupported algorithm', { alg: String(header.alg) });

  // 2 — the key must already be trusted.
  const jwk = typeof header.kid === 'string' ? options.publicKeys.get(header.kid) : undefined;
  if (jwk === undefined) reject('unknown signing key', { kid: String(header.kid) });

  // 3 — signature.
  let signatureValid = false;
  try {
    signatureValid = verify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: DSA_ENCODING },
      decodeBase64Url(encodedSignature),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) reject('bad signature');

  // 4 — registered claims.
  if (claims.iss !== options.issuer) reject('wrong issuer');
  if (options.audience !== undefined && claims.aud !== options.audience) {
    reject('wrong audience', { expected: options.audience });
  }
  if (options.expectedType !== undefined && claims.typ !== options.expectedType) reject('wrong token type');

  if (typeof claims.exp !== 'number') reject('missing expiry');
  const currentTime = now();
  if (currentTime > claims.exp + tolerance) reject('expired');
  if (typeof claims.iat === 'number' && claims.iat > currentTime + tolerance) reject('issued in the future');

  // 5 — scopes, if the caller asked for them.
  if (options.requiredScopes !== undefined) {
    const granted = new Set(claims.scope ?? []);
    const missing = options.requiredScopes.filter((scope) => !granted.has(scope) && !granted.has('admin'));
    if (missing.length > 0) {
      throw new InfraError('FORBIDDEN_SCOPE', `token is missing scope: ${missing.join(', ')}`, {
        details: { missing },
      });
    }
  }

  return claims;
}

/** Reads claims WITHOUT verifying. Only for logging and debugging — never for a decision. */
export function unsafeDecodeClaims(token: string): AccessTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    return JSON.parse(decodeBase64Url(parts[1]).toString('utf8')) as AccessTokenClaims;
  } catch {
    return null;
  }
}
