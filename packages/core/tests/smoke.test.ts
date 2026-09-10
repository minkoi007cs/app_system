import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@infra/core scaffold', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@infra/core');
  });
});
