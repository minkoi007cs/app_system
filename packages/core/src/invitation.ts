/**
 * Invitation tokens.
 *
 * An invitation link is a bearer credential that grants membership, so it gets the same treatment
 * as every other one here: random, hashed at rest, single-use, and short-lived. The email is bound
 * into the acceptance check rather than the token, so forwarding a link to someone else does not
 * hand them the membership.
 */
import { createHash, randomBytes } from 'node:crypto';

export const INVITATION_PREFIX = 'inv_';
export const DEFAULT_INVITATION_TTL_HOURS = 72;

export interface GeneratedInvitation {
  /** Goes in the link. Never stored. */
  raw: string;
  hash: string;
}

export function generateInvitationToken(): GeneratedInvitation {
  const raw = `${INVITATION_PREFIX}${randomBytes(24).toString('base64url')}`;
  return { raw, hash: hashInvitationToken(raw) };
}

export function hashInvitationToken(raw: string): string {
  return createHash('sha256').update(raw.trim(), 'utf8').digest('hex');
}

export function isInvitationTokenValid(raw: string): boolean {
  const value = raw.trim();
  return value.startsWith(INVITATION_PREFIX) && /^[A-Za-z0-9_-]{32}$/.test(value.slice(INVITATION_PREFIX.length));
}

/** Normalises an email for comparison — invitations must not be case-sensitive traps. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
