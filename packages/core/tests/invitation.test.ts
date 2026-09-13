import { describe, expect, it } from 'vitest';
import {
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_PREFIX,
  isInvitationTokenValid,
  normaliseEmail,
} from '../src/index.js';

describe('generateInvitationToken', () => {
  it('produces a prefixed token and its hash', () => {
    const invitation = generateInvitationToken();
    expect(invitation.raw.startsWith(INVITATION_PREFIX)).toBe(true);
    expect(invitation.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(invitation.hash).toBe(hashInvitationToken(invitation.raw));
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 300 }, () => generateInvitationToken().raw));
    expect(seen.size).toBe(300);
  });

  it('validates its own shape', () => {
    expect(isInvitationTokenValid(generateInvitationToken().raw)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const junk of ['', 'inv_', 'abc', `inv_${'a'.repeat(10)}`, `rt_${'a'.repeat(32)}`]) {
      expect(isInvitationTokenValid(junk)).toBe(false);
    }
  });
});

describe('normaliseEmail', () => {
  it('lowercases and trims so an invitation is not case-sensitive', () => {
    expect(normaliseEmail('  Khoi@Example.COM ')).toBe('khoi@example.com');
  });
});
