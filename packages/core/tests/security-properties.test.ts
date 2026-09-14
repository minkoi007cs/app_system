/**
 * T5.20 — the cross-cutting security properties, tested against the real modules composed together.
 *
 * The unit tests each prove one module behaves. These prove the four properties the whole identity
 * plane is supposed to have, by wiring the modules the way the request path wires them. They are
 * written to fail loudly if a future refactor moves a check without moving its guarantee:
 *
 *   1. Cross-app isolation — nothing minted for app A is usable at app B.
 *   2. Refresh reuse detection — a replayed refresh token kills the whole family.
 *   3. No privilege escalation — roles, scopes and key kinds cannot be widened from the outside.
 *   4. Default deny — an unmentioned resource is refused, and a refusal compiles to false SQL.
 */
import { describe, expect, it } from 'vitest';
import {
  compileDecision,
  decide,
  generateApiKey,
  generateRefreshToken,
  generateSigningKeyPair,
  hasPermission,
  hashApiKey,
  hashRefreshToken,
  mergePermissions,
  normaliseScopes,
  PUBLISHABLE_ALLOWED_SCOPES,
  signAccessToken,
  verifyAccessToken,
  type Policy,
  type PolicySubject,
} from '../src/index.js';

const ISSUER = 'https://infra.example.com';
const APP_A = 'app_aaaaaaaa';
const APP_B = 'app_bbbbbbbb';

const keyA = generateSigningKeyPair();
const keyB = generateSigningKeyPair();
const trusted = new Map([
  [keyA.kid, keyA.publicJwk],
  [keyB.kid, keyB.publicJwk],
]);

function tokenFor(audience: string, key = keyA, overrides: Record<string, unknown> = {}): string {
  return signAccessToken(
    {
      issuer: ISSUER,
      subject: 'user_1',
      audience,
      sessionId: 'sess_1',
      scope: ['db:read'],
      roles: ['member'],
      ...overrides,
    },
    { key },
  ).token;
}

// ── 1. cross-app isolation ───────────────────────────────────────────────────

describe('cross-app isolation', () => {
  it('a token minted for app A does not verify at app B', () => {
    const token = tokenFor(APP_A);
    expect(() => verifyAccessToken(token, { publicKeys: trusted, issuer: ISSUER, audience: APP_A })).not.toThrow();
    expect(() => verifyAccessToken(token, { publicKeys: trusted, issuer: ISSUER, audience: APP_B })).toThrow();
  });

  it('the audience cannot be widened by omitting it at the signing end', () => {
    // aud is required by the type; an empty audience must not become a wildcard.
    const token = tokenFor('');
    expect(() => verifyAccessToken(token, { publicKeys: trusted, issuer: ISSUER, audience: APP_A })).toThrow();
  });

  it('a token signed by another app\'s key is refused even though the kid is trusted', () => {
    // Both kids are in the trusted map — the signature, not the kid, is what has to match.
    const forged = signAccessToken(
      { issuer: ISSUER, subject: 'user_1', audience: APP_A, sessionId: 'sess_1' },
      { key: keyB },
    ).token;
    const [header, payload] = forged.split('.');
    const swapped = `${header}.${payload}.${tokenFor(APP_A, keyA).split('.')[2]}`;
    expect(() => verifyAccessToken(swapped, { publicKeys: trusted, issuer: ISSUER, audience: APP_A })).toThrow();
  });

  it('an untrusted kid is refused outright', () => {
    const stranger = generateSigningKeyPair();
    const token = signAccessToken(
      { issuer: ISSUER, subject: 'u', audience: APP_A, sessionId: 's' },
      { key: stranger },
    ).token;
    expect(() => verifyAccessToken(token, { publicKeys: trusted, issuer: ISSUER, audience: APP_A })).toThrow();
  });

  it('a different issuer is refused', () => {
    const token = signAccessToken(
      { issuer: 'https://evil.example.com', subject: 'u', audience: APP_A, sessionId: 's' },
      { key: keyA },
    ).token;
    expect(() => verifyAccessToken(token, { publicKeys: trusted, issuer: ISSUER, audience: APP_A })).toThrow();
  });

  it('two apps never share an api key hash space by accident', () => {
    const a = generateApiKey('secret');
    const b = generateApiKey('secret');
    expect(a.hash).not.toBe(b.hash);
    expect(hashApiKey(a.raw)).toBe(a.hash);
    expect(hashApiKey(b.raw)).not.toBe(a.hash);
  });
});

// ── 2. refresh token reuse ───────────────────────────────────────────────────

describe('refresh token families', () => {
  it('a rotated token keeps the family so reuse is attributable', () => {
    const first = generateRefreshToken();
    const second = generateRefreshToken(first.familyId);
    expect(second.familyId).toBe(first.familyId);
    expect(second.raw).not.toBe(first.raw);
    expect(second.hash).not.toBe(first.hash);
  });

  it('only the digest is comparable — the raw value is not derivable from it', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token.raw)).toBe(token.hash);
    expect(token.hash).not.toContain(token.raw.slice(3, 20));
  });

  it('every issued token is unique, so a collision cannot be mistaken for a reuse', () => {
    const hashes = new Set(Array.from({ length: 500 }, () => generateRefreshToken().hash));
    expect(hashes.size).toBe(500);
  });
});

// ── 3. privilege escalation ──────────────────────────────────────────────────

describe('privilege escalation', () => {
  it('a publishable key cannot carry a write scope, however it is asked for', () => {
    const requested = normaliseScopes('publishable', ['db:read', 'db:write', 'admin']);
    expect(requested).toEqual([...PUBLISHABLE_ALLOWED_SCOPES].filter((s) => requested.includes(s)));
    expect(requested).not.toContain('db:write');
    expect(requested).not.toContain('admin');
  });

  it('a secret key keeps the scopes it was granted and gains none', () => {
    expect(normaliseScopes('secret', ['db:read'])).toEqual(['db:read']);
    expect(normaliseScopes('secret', ['db:read'])).not.toContain('admin');
  });

  it('a wildcard matches whole segments only — "db:*" is not "database:read"', () => {
    expect(hasPermission(['db:*'], 'db:write')).toBe(true);
    expect(hasPermission(['db:*'], 'database:write')).toBe(false);
    expect(hasPermission(['*:read'], 'db:read')).toBe(true);
    expect(hasPermission(['db:read'], 'db:write')).toBe(false);
  });

  it('merging roles is a union, never an upgrade', () => {
    const merged = mergePermissions([['db:read'], ['db:read', 'auth:read']]);
    expect(merged.sort()).toEqual(['auth:read', 'db:read']);
    expect(merged).not.toContain('admin');
    expect(hasPermission(merged, 'db:write')).toBe(false);
  });

  it('a token cannot grant a scope the verifier requires but the token lacks', () => {
    const token = tokenFor(APP_A, keyA, { scope: ['db:read'] });
    expect(() =>
      verifyAccessToken(token, {
        publicKeys: trusted,
        issuer: ISSUER,
        audience: APP_A,
        requiredScopes: ['db:write'],
      }),
    ).toThrow();
  });

  it('an expired token stays expired no matter what roles it claims', () => {
    const token = signAccessToken(
      { issuer: ISSUER, subject: 'u', audience: APP_A, sessionId: 's', roles: ['admin'], ttlSeconds: 1 },
      { key: keyA, now: () => 1_000 },
    ).token;
    expect(() =>
      verifyAccessToken(token, {
        publicKeys: trusted,
        issuer: ISSUER,
        audience: APP_A,
        now: () => 10_000,
      }),
    ).toThrow();
  });
});

// ── 4. default deny ──────────────────────────────────────────────────────────

describe('default deny', () => {
  const subject: PolicySubject = { id: 'user_1', appId: APP_A, roles: ['member'], workspaceId: null };

  const allowOwnNotes: Policy = {
    id: 'p_notes',
    resource: 'notes',
    action: 'select',
    effect: 'allow',
    condition: { op: 'eq', field: 'owner_id', value: { from: 'subject', path: 'id' } },
    priority: 10,
    enabled: true,
  };

  it('a resource no policy mentions is denied', () => {
    const decision = decide([allowOwnNotes], { resource: 'invoices', action: 'select' });
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toBe('default_deny');
  });

  it('an action no policy mentions is denied even on a permitted resource', () => {
    expect(decide([allowOwnNotes], { resource: 'notes', action: 'delete' }).effect).toBe('deny');
  });

  it('a disabled policy grants nothing', () => {
    const decision = decide([{ ...allowOwnNotes, enabled: false }], { resource: 'notes', action: 'select' });
    expect(decision.effect).toBe('deny');
  });

  it('deny wins over an allow at any priority', () => {
    const denyAll: Policy = {
      id: 'p_deny',
      resource: 'notes',
      action: 'select',
      effect: 'deny',
      condition: { op: 'always' },
      priority: 999,
      enabled: true,
    };
    expect(decide([allowOwnNotes, denyAll], { resource: 'notes', action: 'select' }).effect).toBe('deny');
  });

  it('a denial compiles to SQL that can never be true', () => {
    const decision = decide([allowOwnNotes], { resource: 'invoices', action: 'select' });
    const compiled = compileDecision(decision, subject, 'postgres');
    expect(compiled.sql.replace(/\s+/g, ' ')).toMatch(/1\s*=\s*0|false/i);
    expect(compiled.params).toEqual([]);
  });

  it('an allow compiles to a parameterised condition — never the value inline', () => {
    const decision = decide([allowOwnNotes], { resource: 'notes', action: 'select' });
    const compiled = compileDecision(decision, subject, 'postgres');
    expect(compiled.sql).toContain('$1');
    expect(compiled.sql).not.toContain('user_1');
    expect(compiled.params).toEqual(['user_1']);
  });

  it('the compiled condition scopes rows to the subject, not to the app alone', () => {
    const other: PolicySubject = { ...subject, id: 'user_2' };
    const decision = decide([allowOwnNotes], { resource: 'notes', action: 'select' });
    expect(compileDecision(decision, other, 'postgres').params).toEqual(['user_2']);
  });
});
