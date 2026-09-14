import { describe, expect, it } from 'vitest';
import { MAX_IMPERSONATION_MINUTES, MIN_REASON_LENGTH } from '../src/schema/impersonation.js';

describe('impersonation invariants', () => {
  it('caps a session at an hour — longer means starting again with a fresh reason', () => {
    expect(MAX_IMPERSONATION_MINUTES).toBeLessThanOrEqual(60);
    expect(MAX_IMPERSONATION_MINUTES).toBeGreaterThan(0);
  });

  it('requires a reason long enough to mean something', () => {
    expect(MIN_REASON_LENGTH).toBeGreaterThanOrEqual(10);
    expect('test'.length).toBeLessThan(MIN_REASON_LENGTH);
  });
});
