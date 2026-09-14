import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECOVERY_TTL_MINUTES,
  generateRecoveryToken,
  hashRecoveryToken,
  isRecoveryTokenValid,
  RECOVERY_PREFIX,
  recoveryExpiry,
} from '../src/recovery.js';
import { digestsEqual, generateOpaqueToken, hashOpaqueToken, isOpaqueTokenValid } from '../src/opaque-token.js';
import { generateInvitationToken, isInvitationTokenValid } from '../src/invitation.js';

describe('opaque tokens', () => {
  it('are 192 bits of randomness behind a prefix', () => {
    const { raw } = generateOpaqueToken('tst_');
    expect(raw.startsWith('tst_')).toBe(true);
    expect(raw.slice(4)).toHaveLength(32);
  });

  it('never repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateOpaqueToken('tst_').raw));
    expect(seen.size).toBe(500);
  });

  it('store only a digest', () => {
    const { raw, hash } = generateOpaqueToken('tst_');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(raw.slice(4));
    expect(hashOpaqueToken(raw)).toBe(hash);
  });

  it('reject a token carrying the wrong prefix', () => {
    const { raw } = generateOpaqueToken('tst_');
    expect(isOpaqueTokenValid(raw, 'tst_')).toBe(true);
    expect(isOpaqueTokenValid(raw, 'rec_')).toBe(false);
  });

  it('compare digests without a length-dependent early exit', () => {
    const a = hashOpaqueToken('a');
    expect(digestsEqual(a, a)).toBe(true);
    expect(digestsEqual(a, hashOpaqueToken('b'))).toBe(false);
    expect(digestsEqual(a, 'short')).toBe(false);
  });
});

describe('recovery tokens', () => {
  it('carry the rec_ prefix and validate', () => {
    const { raw, hash } = generateRecoveryToken();
    expect(raw.startsWith(RECOVERY_PREFIX)).toBe(true);
    expect(isRecoveryTokenValid(raw)).toBe(true);
    expect(hashRecoveryToken(raw)).toBe(hash);
  });

  it('do not accept an invitation token, and vice versa', () => {
    expect(isRecoveryTokenValid(generateInvitationToken().raw)).toBe(false);
    expect(isInvitationTokenValid(generateRecoveryToken().raw)).toBe(false);
  });

  it('reject malformed input rather than hashing it', () => {
    for (const bad of ['', 'rec_', 'rec_short', 'rec_' + '!'.repeat(32), ' plain ']) {
      expect(isRecoveryTokenValid(bad)).toBe(false);
    }
  });

  it('expire in minutes, not days', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(recoveryExpiry(undefined, now).getTime() - now.getTime()).toBe(
      DEFAULT_RECOVERY_TTL_MINUTES * 60_000,
    );
    expect(DEFAULT_RECOVERY_TTL_MINUTES).toBeLessThanOrEqual(30);
  });
});
