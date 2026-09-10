import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAad, decryptSecret, encryptSecret, InfraError } from '@infra/core';
import { assertValidSlug } from '../src/queries/apps.js';
import { dialectForProvider, envelopeOf, hostHintOf } from '../src/queries/database-configs.js';
import { sqlFingerprint } from '../src/queries/audit-logs.js';
import type { InfraDatabaseConfigRow } from '../src/schema/database-configs.js';

describe('assertValidSlug', () => {
  it('accepts kebab-case slugs', () => {
    expect(assertValidSlug('learning-ai')).toBe('learning-ai');
    expect(assertValidSlug('a1')).toBe('a1');
  });

  it('rejects uppercase, spaces and edge hyphens', () => {
    for (const bad of ['Learning', 'my app', '-app', 'app-', '', 'a'.repeat(64)]) {
      expect(() => assertValidSlug(bad)).toThrowError(InfraError);
    }
  });
});

describe('dialectForProvider', () => {
  it('maps every free-tier provider to its dialect', () => {
    expect(dialectForProvider('neon')).toBe('postgres');
    expect(dialectForProvider('supabase')).toBe('postgres');
    expect(dialectForProvider('turso')).toBe('libsql');
  });
});

describe('hostHintOf', () => {
  it('extracts the host without credentials', () => {
    const hint = hostHintOf('postgresql://user:secret@ep-cool-1.neon.tech:5432/db?sslmode=require');
    expect(hint).toBe('ep-cool-1.neon.tech:5432');
    expect(hint).not.toContain('secret');
  });

  it('returns null for junk', () => {
    expect(hostHintOf('not a url')).toBeNull();
  });
});

describe('envelopeOf', () => {
  it('round-trips through the row shape with row-bound AAD', () => {
    const key = randomBytes(32);
    const appId = '11111111-1111-4111-8111-111111111111';
    const configId = '22222222-2222-4222-8222-222222222222';
    const dsn = 'libsql://app-user.turso.io?authToken=abc123';

    const sealed = encryptSecret(dsn, buildAad(appId, configId), { key });
    const row = {
      id: configId,
      appId,
      encryptedConnectionString: sealed.ciphertext,
      encryptionIv: sealed.iv,
      encryptionAuthTag: sealed.authTag,
      encryptionKeyVersion: sealed.keyVersion,
    } as InfraDatabaseConfigRow;

    expect(decryptSecret(envelopeOf(row), buildAad(appId, configId), { key })).toBe(dsn);
    expect(() => decryptSecret(envelopeOf(row), buildAad('other-app', configId), { key })).toThrowError(
      InfraError,
    );
  });
});

describe('sqlFingerprint', () => {
  it('is stable across whitespace differences', () => {
    expect(sqlFingerprint('select  1\n from t')).toBe(sqlFingerprint('select 1 from t'));
  });

  it('differs for different statements and never contains the sql', () => {
    const fp = sqlFingerprint('select * from notes where owner = $1');
    expect(fp).toHaveLength(16);
    expect(fp).not.toContain('notes');
    expect(fp).not.toBe(sqlFingerprint('select * from users'));
  });
});
