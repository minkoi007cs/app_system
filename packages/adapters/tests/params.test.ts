import { describe, expect, it } from 'vitest';
import { InfraError } from '@infra/core';
import { toLibsqlParams, toPostgresParams } from '../src/index.js';

describe('toPostgresParams', () => {
  it('passes through serialisable values', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toPostgresParams(['a', 1, true, null, date, bytes])).toEqual(['a', 1, true, null, date, bytes]);
  });

  it('maps undefined to null and bigint to string', () => {
    expect(toPostgresParams([undefined, 9007199254740993n])).toEqual([null, '9007199254740993']);
  });

  it('rejects objects and functions, naming the position', () => {
    try {
      toPostgresParams(['ok', { nested: true }]);
      expect.unreachable('should reject');
    } catch (error) {
      expect(InfraError.is(error)).toBe(true);
      expect((error as InfraError).code).toBe('VALIDATION_FAILED');
      expect((error as InfraError).message).toContain('#2');
    }
  });
});

describe('toLibsqlParams', () => {
  it('normalises booleans and dates for SQLite', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(toLibsqlParams([true, false, date])).toEqual([1, 0, '2026-01-01T00:00:00.000Z']);
  });

  it('keeps strings, numbers, bigints and blobs', () => {
    const bytes = new Uint8Array([9]);
    expect(toLibsqlParams(['a', 2, 3n, bytes, null])).toEqual(['a', 2, 3n, bytes, null]);
  });

  it('rejects unsupported types', () => {
    expect(() => toLibsqlParams([Symbol('x')])).toThrowError(InfraError);
  });
});
