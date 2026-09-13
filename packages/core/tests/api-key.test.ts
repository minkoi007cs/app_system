import { describe, expect, it } from 'vitest';
import {
  apiKeyFromAuthorizationHeader,
  apiKeyPrefix,
  apiKeyPrefixFor,
  apiKeyShapeOf,
  generateApiKey,
  hasScope,
  hashApiKey,
  InfraError,
  isApiKeyFormatValid,
  looksLikeBrowserRequest,
  maskApiKey,
  normaliseScopes,
  parseApiKey,
} from '../src/index.js';

describe('key kinds', () => {
  it('defaults to a secret key', () => {
    const key = generateApiKey();
    expect(key.kind).toBe('secret');
    expect(key.raw).toMatch(/^sk_live_[0-9A-Za-z]{32}$/);
  });

  it('produces publishable keys on request', () => {
    const key = generateApiKey('publishable');
    expect(key.raw).toMatch(/^pk_live_[0-9A-Za-z]{32}$/);
    expect(key.kind).toBe('publishable');
  });

  it('covers all four prefixes', () => {
    expect(apiKeyPrefixFor('secret', 'live')).toBe('sk_live_');
    expect(apiKeyPrefixFor('secret', 'test')).toBe('sk_test_');
    expect(apiKeyPrefixFor('publishable', 'live')).toBe('pk_live_');
    expect(apiKeyPrefixFor('publishable', 'test')).toBe('pk_test_');
  });

  it('recognises the kind from the raw key', () => {
    expect(apiKeyShapeOf(generateApiKey('secret', 'test').raw)).toMatchObject({
      kind: 'secret',
      environment: 'test',
    });
    expect(apiKeyShapeOf(generateApiKey('publishable').raw)?.kind).toBe('publishable');
    expect(apiKeyShapeOf('nope')).toBeNull();
  });

  it('parses both kinds', () => {
    for (const kind of ['secret', 'publishable'] as const) {
      const key = generateApiKey(kind);
      const parsed = parseApiKey(key.raw);
      expect(parsed.kind).toBe(kind);
      expect(parsed.hash).toBe(key.hash);
      expect(parsed.secret).toHaveLength(32);
    }
  });
});

describe('scope capping', () => {
  it('leaves secret key scopes alone', () => {
    expect(normaliseScopes('secret', ['db:write', 'admin'])).toEqual(['db:write', 'admin']);
  });

  it('strips write and admin from a publishable key', () => {
    expect(normaliseScopes('publishable', ['db:read', 'db:write', 'admin', 'auth:read'])).toEqual([
      'db:read',
      'auth:read',
    ]);
  });

  it('falls back to auth:read when nothing survives', () => {
    expect(normaliseScopes('publishable', ['db:write', 'admin'])).toEqual(['auth:read']);
  });
});

describe('hashing and display', () => {
  it('stores only a sha256 hash', () => {
    const key = generateApiKey();
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.hash).not.toContain(key.raw);
    expect(hashApiKey(key.raw)).toBe(key.hash);
    expect(hashApiKey(`  ${key.raw}\n`)).toBe(key.hash);
  });

  it('never repeats a key', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateApiKey().raw));
    expect(seen.size).toBe(500);
  });

  it('shows a prefix that hides the secret', () => {
    const key = generateApiKey();
    expect(key.prefix).toMatch(/^sk_live_[0-9A-Za-z]{8}$/);
    expect(apiKeyPrefix(key.raw)).toBe(key.prefix);
    const masked = maskApiKey(key.raw);
    expect(masked.startsWith(key.prefix)).toBe(true);
    expect(masked).toHaveLength(key.raw.length);
  });
});

describe('validation', () => {
  it('accepts well-formed keys of both kinds', () => {
    expect(isApiKeyFormatValid(generateApiKey('secret').raw)).toBe(true);
    expect(isApiKeyFormatValid(generateApiKey('publishable', 'test').raw)).toBe(true);
  });

  it('rejects malformed keys', () => {
    for (const junk of ['', 'sk_live_short', 'xx_live_' + 'a'.repeat(32), `pk_live_${'*'.repeat(32)}`]) {
      expect(isApiKeyFormatValid(junk)).toBe(false);
    }
  });

  it('throws API_KEY_MALFORMED with a 401', () => {
    try {
      parseApiKey('hello');
      expect.unreachable('should reject');
    } catch (error) {
      expect((error as InfraError).code).toBe('API_KEY_MALFORMED');
      expect((error as InfraError).httpStatus).toBe(401);
    }
  });
});

describe('scopes and headers', () => {
  it('admin implies every scope', () => {
    expect(hasScope(['admin'], 'db:write')).toBe(true);
    expect(hasScope(['db:read'], 'db:write')).toBe(false);
  });

  it('extracts a bearer token', () => {
    expect(apiKeyFromAuthorizationHeader('Bearer sk_live_abc')).toBe('sk_live_abc');
    expect(apiKeyFromAuthorizationHeader('Basic abc')).toBeNull();
    expect(apiKeyFromAuthorizationHeader(null)).toBeNull();
  });
});

describe('looksLikeBrowserRequest', () => {
  it('flags a request carrying an origin or referer', () => {
    expect(looksLikeBrowserRequest('https://app.example.com', null)).toBe(true);
    expect(looksLikeBrowserRequest(null, 'https://app.example.com/page')).toBe(true);
  });

  it('treats a server-to-server call as not a browser', () => {
    expect(looksLikeBrowserRequest(null, null)).toBe(false);
    expect(looksLikeBrowserRequest('', '')).toBe(false);
  });
});
