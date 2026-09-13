import { describe, expect, it } from 'vitest';
import {
  decodeTokenHeader,
  generateSigningKeyPair,
  InfraError,
  signAccessToken,
  unsafeDecodeClaims,
  verifyAccessToken,
} from '../src/index.js';

const key = generateSigningKeyPair();
const otherKey = generateSigningKeyPair();
const keys = new Map([[key.kid, key.publicJwk]]);
const ISSUER = 'https://infra.test';
const base = { issuer: ISSUER, subject: 'user_1', audience: 'app_A', sessionId: 'sess_1' };

function parts(token: string): [string, string, string] {
  const [header, payload, signature] = token.split('.');
  return [header ?? '', payload ?? '', signature ?? ''];
}

describe('signAccessToken', () => {
  it('produces a three-part ES256 token naming its key', () => {
    const { token } = signAccessToken(base, { key });
    expect(token.split('.')).toHaveLength(3);
    expect(decodeTokenHeader(token)).toMatchObject({ alg: 'ES256', typ: 'JWT', kid: key.kid });
  });

  it('defaults to a 10 minute lifetime', () => {
    const { claims } = signAccessToken(base, { key });
    expect(claims.exp - claims.iat).toBe(600);
  });

  it('carries app scoping, roles and a null workspace by default', () => {
    const { claims } = signAccessToken({ ...base, scope: ['db:read'], roles: ['member'] }, { key });
    expect(claims.aud).toBe('app_A');
    expect(claims.wid).toBeNull();
    expect(claims.act).toBeNull();
    expect(claims.typ).toBe('access');
  });

  it('gives every token a unique id', () => {
    const ids = new Set(Array.from({ length: 100 }, () => signAccessToken(base, { key }).claims.jti));
    expect(ids.size).toBe(100);
  });
});

describe('verifyAccessToken — the happy path', () => {
  it('round-trips', () => {
    const { token } = signAccessToken({ ...base, scope: ['db:read'], amr: ['pwd'] }, { key });
    const claims = verifyAccessToken(token, { publicKeys: keys, issuer: ISSUER, audience: 'app_A' });
    expect(claims.sub).toBe('user_1');
    expect(claims.amr).toEqual(['pwd']);
  });

  it('keeps the actor claim through an impersonation token', () => {
    const { token } = signAccessToken(
      { ...base, type: 'impersonation', actor: { sub: 'admin_1', reason: 'ticket 42' }, workspaceId: 'ws_1' },
      { key },
    );
    const claims = verifyAccessToken(token, {
      publicKeys: keys,
      issuer: ISSUER,
      expectedType: 'impersonation',
    });
    expect(claims.act?.sub).toBe('admin_1');
    expect(claims.wid).toBe('ws_1');
  });
});

describe('verifyAccessToken — attacks', () => {
  it('rejects a token minted for another app', () => {
    const { token } = signAccessToken(base, { key });
    expect(() => verifyAccessToken(token, { publicKeys: keys, issuer: ISSUER, audience: 'app_B' })).toThrowError(
      /audience/,
    );
  });

  it('rejects another issuer', () => {
    const { token } = signAccessToken(base, { key });
    expect(() =>
      verifyAccessToken(token, { publicKeys: keys, issuer: 'https://evil.test' }),
    ).toThrowError(/issuer/);
  });

  it('rejects a key it does not already trust', () => {
    const { token } = signAccessToken(base, { key: otherKey });
    expect(() => verifyAccessToken(token, { publicKeys: keys, issuer: ISSUER })).toThrowError(/signing key/);
  });

  it('rejects a tampered payload', () => {
    const { token, claims } = signAccessToken(base, { key });
    const [header, , signature] = parts(token);
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'admin' })).toString('base64url');
    expect(() =>
      verifyAccessToken(`${header}.${forged}.${signature}`, { publicKeys: keys, issuer: ISSUER }),
    ).toThrowError(/signature/);
  });

  it('rejects alg=none', () => {
    const { token } = signAccessToken(base, { key });
    const [, payload] = parts(token);
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: key.kid })).toString('base64url');
    expect(() => verifyAccessToken(`${header}.${payload}.`, { publicKeys: keys, issuer: ISSUER })).toThrowError(
      /algorithm/,
    );
  });

  it('rejects an HS256 algorithm-confusion attempt', () => {
    const { token } = signAccessToken(base, { key });
    const [, payload, signature] = parts(token);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: key.kid })).toString('base64url');
    expect(() =>
      verifyAccessToken(`${header}.${payload}.${signature}`, { publicKeys: keys, issuer: ISSUER }),
    ).toThrowError(/algorithm/);
  });

  it('rejects a signature produced by a different key but labelled with a trusted kid', () => {
    const trusted = signAccessToken(base, { key });
    const forged = signAccessToken(base, { key: otherKey });
    const [header] = parts(trusted.token);
    const [, payload, signature] = parts(forged.token);
    expect(() =>
      verifyAccessToken(`${header}.${payload}.${signature}`, { publicKeys: keys, issuer: ISSUER }),
    ).toThrowError(/signature/);
  });

  it('rejects garbage', () => {
    for (const junk of ['', 'abc', 'a.b', 'a.b.c.d']) {
      expect(() => verifyAccessToken(junk, { publicKeys: keys, issuer: ISSUER })).toThrowError(InfraError);
    }
  });

  it('answers 401 for every rejection', () => {
    try {
      verifyAccessToken('a.b.c', { publicKeys: keys, issuer: ISSUER });
      expect.unreachable('should reject');
    } catch (error) {
      expect(InfraError.is(error)).toBe(true);
      expect((error as InfraError).httpStatus).toBe(401);
    }
  });
});

describe('verifyAccessToken — time', () => {
  const t0 = 1_800_000_000;

  it('accepts a token inside its lifetime', () => {
    const { token } = signAccessToken({ ...base, ttlSeconds: 60 }, { key, now: () => t0 });
    expect(verifyAccessToken(token, { publicKeys: keys, issuer: ISSUER, now: () => t0 + 59 }).sub).toBe('user_1');
  });

  it('allows 30 seconds of clock skew', () => {
    const { token } = signAccessToken({ ...base, ttlSeconds: 60 }, { key, now: () => t0 });
    expect(verifyAccessToken(token, { publicKeys: keys, issuer: ISSUER, now: () => t0 + 85 }).sub).toBe('user_1');
  });

  it('rejects an expired token', () => {
    const { token } = signAccessToken({ ...base, ttlSeconds: 60 }, { key, now: () => t0 });
    expect(() =>
      verifyAccessToken(token, { publicKeys: keys, issuer: ISSUER, now: () => t0 + 200 }),
    ).toThrowError(/expired/);
  });

  it('rejects a token issued in the future', () => {
    const { token } = signAccessToken(base, { key, now: () => t0 + 10_000 });
    expect(() => verifyAccessToken(token, { publicKeys: keys, issuer: ISSUER, now: () => t0 })).toThrowError(
      /future/,
    );
  });
});

describe('verifyAccessToken — scopes and types', () => {
  it('enforces required scopes', () => {
    const { token } = signAccessToken({ ...base, scope: ['db:read'] }, { key });
    expect(verifyAccessToken(token, { publicKeys: keys, issuer: ISSUER, requiredScopes: ['db:read'] }).scope).toEqual(
      ['db:read'],
    );
    expect(() =>
      verifyAccessToken(token, { publicKeys: keys, issuer: ISSUER, requiredScopes: ['db:write'] }),
    ).toThrowError(/scope/);
  });

  it('treats admin as covering every scope', () => {
    const { token } = signAccessToken({ ...base, scope: ['admin'] }, { key });
    expect(
      verifyAccessToken(token, { publicKeys: keys, issuer: ISSUER, requiredScopes: ['db:write'] }).scope,
    ).toEqual(['admin']);
  });

  it('refuses a token of the wrong type', () => {
    const { token } = signAccessToken({ ...base, type: 'impersonation' }, { key });
    expect(() =>
      verifyAccessToken(token, { publicKeys: keys, issuer: ISSUER, expectedType: 'access' }),
    ).toThrowError(/token type/);
  });
});

describe('key material', () => {
  it('exports a public JWK carrying kid, alg and use', () => {
    expect(key.publicJwk).toMatchObject({ kid: key.kid, alg: 'ES256', use: 'sig', kty: 'EC', crv: 'P-256' });
  });

  it('never puts the private key in the public JWK', () => {
    expect(JSON.stringify(key.publicJwk)).not.toContain('PRIVATE');
    expect((key.publicJwk as Record<string, unknown>)['d']).toBeUndefined();
  });

  it('gives each keypair a distinct kid', () => {
    const kids = new Set(Array.from({ length: 20 }, () => generateSigningKeyPair().kid));
    expect(kids.size).toBe(20);
  });
});

describe('unsafeDecodeClaims', () => {
  it('reads claims without checking anything', () => {
    const { token } = signAccessToken(base, { key });
    expect(unsafeDecodeClaims(token)?.sub).toBe('user_1');
  });

  it('returns null for junk instead of throwing', () => {
    expect(unsafeDecodeClaims('not-a-token')).toBeNull();
  });
});
