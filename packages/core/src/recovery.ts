/**
 * Account-recovery tokens.
 *
 * A password reset link is the single most valuable credential a platform hands out: it is a
 * bearer token that mints a new password for an account whose password the holder does not know.
 * Three rules follow from that, and this module exists to make them hard to forget.
 *
 *   1. Short-lived. 15 minutes, not 24 hours — long enough to walk to the inbox, short enough that
 *      a link sitting in a forwarded mail thread is already dead.
 *   2. Single-use, burned atomically. See consumeRecoveryToken in @infra/db: the burn is an
 *      UPDATE ... WHERE used_at IS NULL RETURNING, so two concurrent redemptions cannot both win.
 *   3. Issuing one must never reveal whether the address exists. The endpoint answers the same way
 *      either way; this module simply has no branch that leaks.
 */
import {
  generateOpaqueToken,
  hashOpaqueToken,
  isOpaqueTokenValid,
  type GeneratedOpaqueToken,
} from './opaque-token.js';

export const RECOVERY_PREFIX = 'rec_';
export const DEFAULT_RECOVERY_TTL_MINUTES = 15;

export type GeneratedRecoveryToken = GeneratedOpaqueToken;

export function generateRecoveryToken(): GeneratedRecoveryToken {
  return generateOpaqueToken(RECOVERY_PREFIX);
}

export function hashRecoveryToken(raw: string): string {
  return hashOpaqueToken(raw);
}

export function isRecoveryTokenValid(raw: string): boolean {
  return isOpaqueTokenValid(raw, RECOVERY_PREFIX);
}

export function recoveryExpiry(
  ttlMinutes: number = DEFAULT_RECOVERY_TTL_MINUTES,
  now: Date = new Date(),
): Date {
  return new Date(now.getTime() + ttlMinutes * 60_000);
}
