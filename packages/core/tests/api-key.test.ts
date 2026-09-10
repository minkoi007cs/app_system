import { describe, expect, it } from 'vitest';
import {
  apiKeyFromAuthorizationHeader,
  apiKeyPrefix,
  generateApiKey,
  hasScope,
  hashApiKey,
  InfraError,
  isApiKeyFormatValid,
  maskApiKey,
  parseApiKey,
} from '../src/index.js';

describe('generateApiKey', () => {
  it('produces a pk_live_ key of 40 characters', () => {
    const key = generateApiKey();
    expect(key.raw).toMatch(/^pk_live_[0-9A-Za-z]{32}$/);
    expect(key.raw).toHaveLength(40);
    expect(key.environment).toBe('live');
  });

  it('produces pk_test_ keys on request', () => {
    expect(generateApiKey('test').raw.startsWith('pk_test_')).toBe(true);
  });

  it('never repeats a key', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generateApiKey().raw);
    expect(seen.size).toBe(500);
  });

  it('returns a sha256 hash, not the raw key', () => {
    const key = generateApiKey();
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.hash).not.toContain(key.raw);
    expect(key.hash).toBe(hashApiKey(key.raw));
  });

  it('exposes a display prefix that hides the secret', () => {
    const key = generateApiKey();
    expect(key.prefix).toMatch(/^pk_live_[0-9A-Za-z]{8}$/);
    expect(key.raw.startsWith(key.prefix)).toBe(true);
    expect(key.prefix.length).toBeLessThan(key.raw.length);
  });
});

describe('hashApiKey', () => {
  it('is deterministic and ignores surrounding whitespace', () => {
    const raw = generateApiKey().raw;
    expect(hashApiKey(raw)).toBe(hashApiKey(`  ${raw}\n`));
  });

  it('differs for different keys', () => {
    expect(hashApiKey(generateApiKey().raw)).not.toBe(hashApiKey(generateApiKey().raw));
  });
});

describe('validation and parsing', () => {
  it('accepts well-formed keys', () => {
    expect(isApiKeyFormatValid(generateApiKey().raw)).toBe(true);
    expect(isApiKeyFormatValid(generateApiKey('test').raw)).toBe(true);
  });

  it('rejects malformed keys', () => {
    expect(isApiKeyFormatValid('sk_live_abc')).toBe(false);
    expect(isApiKeyFormatValid('pk_live_short')).toBe(false);
    expect(isApiKeyFormatValid(`pk_live_${'*'.repeat(32)}`)).toBe(false);
    expect(isApiKeyFormatValid('')).toBe(false);
  });

  it('parseApiKey throws API_KEY_MALFORMED on junk', () => {
    try {
      parseApiKey('hello');
      expect.unreachable('should reject');
    } catch (error) {
      expect(InfraError.is(error)).toBe(true);
      expect((error as InfraError).code).toBe('API_KEY_MALFORMED');
      expect((error as InfraError).httpStatus).toBe(401);
    }
  });

  it('parseApiKey returns hash and prefix', () => {
    const key = generateApiKey();
    const parsed = parseApiKey(key.raw);
    expect(parsed.hash).toBe(key.hash);
    expect(parsed.prefix).toBe(key.prefix);
    expect(parsed.secret).toHaveLength(32);
  });

  it('apiKeyPrefix rejects a key with no known prefix', () => {
    expect(() => apiKeyPrefix('nope')).toThrowError(InfraError);
  });
});

describe('maskApiKey', () => {
  it('keeps the prefix and hides the rest', () => {
    const key = generateApiKey();
    const masked = maskApiKey(key.raw);
    expect(masked.startsWith(key.prefix)).toBe(true);
    expect(masked).toHaveLength(key.raw.length);
    expect(masked.slice(key.prefix.length)).toMatch(/^•+$/);
  });
});

describe('scopes and headers', () => {
  it('admin implies every scope', () => {
    expect(hasScope(['admin'], 'db:write')).toBe(true);
    expect(hasScope(['db:read'], 'db:write')).toBe(false);
    expect(hasScope(['db:read'], 'db:read')).toBe(true);
  });

  it('extracts a bearer token', () => {
    expect(apiKeyFromAuthorizationHeader('Bearer pk_live_abc')).toBe('pk_live_abc');
    expect(apiKeyFromAuthorizationHeader('bearer  pk_live_abc ')).toBe('pk_live_abc');
    expect(apiKeyFromAuthorizationHeader('Basic abc')).toBeNull();
    expect(apiKeyFromAuthorizationHeader(null)).toBeNull();
    expect(apiKeyFromAuthorizationHeader(undefined)).toBeNull();
  });
});
