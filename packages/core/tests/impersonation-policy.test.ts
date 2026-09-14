/**
 * The impersonation constraints that are pure policy rather than SQL.
 * The refusal paths that need a database live in the db package's own tests.
 */
import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, signAccessToken, verifyAccessToken } from '../src/jwt.js';

const ISSUER = 'https://infra.example.com';
const APP = 'app_1';
const key = generateSigningKeyPair();
const trusted = new Map([[key.kid, key.publicJwk]]);

describe('the act claim', () => {
  it('records the real person behind an impersonated token', () => {
    const signed = signAccessToken(
      {
        issuer: ISSUER,
        subject: 'user_target',
        audience: APP,
        sessionId: 'sess_1',
        actor: { sub: 'admin_real', reason: 'support ticket SUP-4711' },
      },
      { key },
    );

    const claims = verifyAccessToken(signed.token, {
      publicKeys: trusted,
      issuer: ISSUER,
      audience: APP,
    });

    // sub is who the request appears to be; act is who it actually is. An audit record that shows
    // only sub would attribute a support action to the customer.
    expect(claims.sub).toBe('user_target');
    expect(claims.act?.sub).toBe('admin_real');
    expect(claims.act?.reason).toContain('SUP-4711');
  });

  it('is null on an ordinary token, so its presence always means something', () => {
    const signed = signAccessToken(
      { issuer: ISSUER, subject: 'user_1', audience: APP, sessionId: 's' },
      { key },
    );
    const claims = verifyAccessToken(signed.token, {
      publicKeys: trusted,
      issuer: ISSUER,
      audience: APP,
    });
    expect(claims.act).toBeNull();
  });

  it('cannot be added to a token after signing', () => {
    const signed = signAccessToken(
      { issuer: ISSUER, subject: 'user_1', audience: APP, sessionId: 's' },
      { key },
    );

    const [header, payload, signature] = signed.token.split('.');
    const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    decoded['act'] = { sub: 'attacker' };
    const forged = `${header}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;

    expect(() =>
      verifyAccessToken(forged, { publicKeys: trusted, issuer: ISSUER, audience: APP }),
    ).toThrow();
  });

  it('an impersonated token still expires like any other', () => {
    const signed = signAccessToken(
      {
        issuer: ISSUER,
        subject: 'user_target',
        audience: APP,
        sessionId: 's',
        actor: { sub: 'admin_real' },
        ttlSeconds: 60,
      },
      { key, now: () => 1_000 },
    );

    expect(() =>
      verifyAccessToken(signed.token, {
        publicKeys: trusted,
        issuer: ISSUER,
        audience: APP,
        now: () => 5_000,
      }),
    ).toThrow();
  });
});
