import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configuredOAuthProviders, InfraError, parseServerEnv } from '../src/index.js';

const base = {
  INFRA_MASTER_DATABASE_URL: 'postgresql://user:pw@ep-x.neon.tech/infra?sslmode=require',
  INFRA_MASTER_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  BETTER_AUTH_SECRET: 'a-long-enough-secret-value',
  BETTER_AUTH_URL: 'http://localhost:3000',
} satisfies NodeJS.ProcessEnv;

describe('parseServerEnv', () => {
  it('applies defaults', () => {
    const env = parseServerEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.INFRA_LOG_LEVEL).toBe('info');
    expect(env.INFRA_PUBLIC_URL).toBe('http://localhost:3000');
  });

  it('rejects a missing encryption key and names the variable', () => {
    const { INFRA_MASTER_ENCRYPTION_KEY: _omitted, ...rest } = base;
    try {
      parseServerEnv(rest as NodeJS.ProcessEnv);
      expect.unreachable('should reject');
    } catch (error) {
      expect(InfraError.is(error)).toBe(true);
      expect((error as InfraError).code).toBe('CONFIG_INVALID');
      expect((error as InfraError).message).toContain('INFRA_MASTER_ENCRYPTION_KEY');
    }
  });

  it('rejects a non-hex encryption key without printing it', () => {
    try {
      parseServerEnv({ ...base, INFRA_MASTER_ENCRYPTION_KEY: 'zz-not-hex' } as NodeJS.ProcessEnv);
      expect.unreachable('should reject');
    } catch (error) {
      expect((error as InfraError).message).not.toContain('zz-not-hex');
      expect((error as InfraError).message).toMatch(/64 hexadecimal/);
    }
  });

  it('rejects a short auth secret', () => {
    expect(() => parseServerEnv({ ...base, BETTER_AUTH_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrowError(
      /BETTER_AUTH_SECRET/,
    );
  });
});

describe('configuredOAuthProviders', () => {
  it('lists only fully configured providers', () => {
    const env = parseServerEnv({
      ...base,
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
      GOOGLE_CLIENT_ID: 'id-only',
    } as NodeJS.ProcessEnv);
    expect(configuredOAuthProviders(env)).toEqual(['github']);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(configuredOAuthProviders(parseServerEnv({ ...base } as NodeJS.ProcessEnv))).toEqual([]);
  });
});
