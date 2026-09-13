/**
 * Refresh tokens.
 *
 * A refresh token is a long-lived bearer credential, so it gets the same treatment as an API key:
 * only its SHA-256 hash is stored. What makes it safe to hand out for 30 days is rotation —
 * every use mints a replacement and burns the old one — plus reuse detection: a token presented
 * twice means a copy exists somewhere, and the whole family is revoked on the spot.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const REFRESH_TOKEN_PREFIX = 'rt_';
export const REFRESH_TOKEN_BYTES = 32; // 256 bits
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface GeneratedRefreshToken {
  /** Returned to the caller once. Never stored, never logged. */
  raw: string;
  hash: string;
  /** Groups every rotation of one login together, so they can be revoked as a unit. */
  familyId: string;
}

export function generateRefreshToken(familyId?: string): GeneratedRefreshToken {
  const raw = `${REFRESH_TOKEN_PREFIX}${randomBytes(REFRESH_TOKEN_BYTES).toString('base64url')}`;
  return {
    raw,
    hash: hashRefreshToken(raw),
    familyId: familyId ?? randomUUID(),
  };
}

export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw.trim(), 'utf8').digest('hex');
}

export function isRefreshTokenFormatValid(raw: string): boolean {
  const value = raw.trim();
  if (!value.startsWith(REFRESH_TOKEN_PREFIX)) return false;
  const secret = value.slice(REFRESH_TOKEN_PREFIX.length);
  // base64url of 32 bytes is 43 characters, unpadded.
  return /^[A-Za-z0-9_-]{43}$/.test(secret);
}
