/**
 * Opaque bearer tokens — invitations, password recovery, anything that travels in a link.
 *
 * One implementation so every one of them gets the same three properties: 192 bits from the CSPRNG,
 * only the SHA-256 digest at rest, and a prefix so a leaked string is identifiable in a log without
 * being usable. Never build one of these out of a user id, a timestamp or a counter.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 24 bytes → 32 base64url characters, no padding. */
export const TOKEN_BYTES = 24;
export const TOKEN_BODY_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export interface GeneratedOpaqueToken {
  /** Goes in the link. Never stored, never recoverable. */
  raw: string;
  hash: string;
}

export function generateOpaqueToken(prefix: string): GeneratedOpaqueToken {
  const raw = `${prefix}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return { raw, hash: hashOpaqueToken(raw) };
}

export function hashOpaqueToken(raw: string): string {
  return createHash('sha256').update(raw.trim(), 'utf8').digest('hex');
}

export function isOpaqueTokenValid(raw: string, prefix: string): boolean {
  const value = raw.trim();
  if (!value.startsWith(prefix)) return false;
  return TOKEN_BODY_PATTERN.test(value.slice(prefix.length));
}

/**
 * Constant-time digest comparison. Lookups go through a unique index on the hash so this is
 * belt-and-braces, but any place that compares two secrets by hand uses it.
 */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
