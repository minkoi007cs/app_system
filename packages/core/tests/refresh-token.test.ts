import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  isRefreshTokenFormatValid,
  REFRESH_TOKEN_PREFIX,
} from '../src/index.js';

describe('generateRefreshToken', () => {
  it('produces a prefixed 256-bit token', () => {
    const token = generateRefreshToken();
    expect(token.raw.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
    expect(token.raw.slice(REFRESH_TOKEN_PREFIX.length)).toHaveLength(43); // 32 bytes, base64url
    expect(isRefreshTokenFormatValid(token.raw)).toBe(true);
  });

  it('returns a hash rather than expecting the caller to store the raw value', () => {
    const token = generateRefreshToken();
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.hash).toBe(hashRefreshToken(token.raw));
    expect(token.hash).not.toContain(token.raw);
  });

  it('starts a new family by default', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.familyId).not.toBe(b.familyId);
  });

  it('continues a family when rotating', () => {
    const first = generateRefreshToken();
    const rotated = generateRefreshToken(first.familyId);
    expect(rotated.familyId).toBe(first.familyId);
    expect(rotated.raw).not.toBe(first.raw);
  });

  it('never repeats a token', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateRefreshToken().raw));
    expect(seen.size).toBe(500);
  });

  it('defaults to a 30 day lifetime', () => {
    expect(DEFAULT_REFRESH_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});

describe('isRefreshTokenFormatValid', () => {
  it('rejects anything that is not one of ours', () => {
    for (const junk of ['', 'rt_', 'abc', `rt_${'a'.repeat(10)}`, `sk_live_${'a'.repeat(32)}`]) {
      expect(isRefreshTokenFormatValid(junk)).toBe(false);
    }
  });
});
