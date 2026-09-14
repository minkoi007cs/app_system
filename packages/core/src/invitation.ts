/**
 * Invitation tokens.
 *
 * An invitation link is a bearer credential that grants membership, so it gets the same treatment
 * as every other one here: random, hashed at rest, single-use, and short-lived. The email is bound
 * into the acceptance check rather than the token, so forwarding a link to someone else does not
 * hand them the membership.
 */
import {
  generateOpaqueToken,
  hashOpaqueToken,
  isOpaqueTokenValid,
  type GeneratedOpaqueToken,
} from './opaque-token.js';

export const INVITATION_PREFIX = 'inv_';
export const DEFAULT_INVITATION_TTL_HOURS = 72;

export type GeneratedInvitation = GeneratedOpaqueToken;

export function generateInvitationToken(): GeneratedInvitation {
  return generateOpaqueToken(INVITATION_PREFIX);
}

export function hashInvitationToken(raw: string): string {
  return hashOpaqueToken(raw);
}

export function isInvitationTokenValid(raw: string): boolean {
  return isOpaqueTokenValid(raw, INVITATION_PREFIX);
}

/** Normalises an email for comparison — invitations must not be case-sensitive traps. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
