import { describe, expect, it } from 'vitest';
import { checkQuota, ORPHAN_AFTER_ATTEMPTS } from '../src/queries/provisioning.js';
import type { InfraProviderQuotaRow } from '../src/schema/provisioning.js';

const row = (used: number, quotaLimit: number | null): InfraProviderQuotaRow => ({
  provider: 'neon',
  used,
  quotaLimit,
  lastError: null,
  checkedAt: new Date(),
});

describe('checkQuota', () => {
  it('allows while there is room', () => {
    expect(checkQuota(row(3, 10)).allowed).toBe(true);
  });

  it('refuses at the ceiling and says so without inventing a number', () => {
    const verdict = checkQuota(row(10, 10));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('10/10');
  });

  it('respects the requested headroom', () => {
    expect(checkQuota(row(9, 10), 1).allowed).toBe(false);
    expect(checkQuota(row(8, 10), 1).allowed).toBe(true);
  });

  it('fails open when no reading exists — a background poll must not gate app creation', () => {
    expect(checkQuota(undefined).allowed).toBe(true);
    expect(checkQuota(undefined).reason).toBe('no reading yet');
  });

  it('allows when the provider publishes no ceiling', () => {
    expect(checkQuota(row(9_999, null)).allowed).toBe(true);
  });

  it('flags an orphan only after several failed releases, never on the first', () => {
    expect(ORPHAN_AFTER_ATTEMPTS).toBeGreaterThan(1);
  });
});
