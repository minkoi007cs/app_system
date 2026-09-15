import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertMasterKey,
  buildAad,
  CURRENT_KEY_VERSION,
  currentKeyVersion,
  decryptSecret,
  encryptSecret,
  InfraError,
  loadMasterKey,
  masterKeyEnvVar,
  parseMasterKey,
} from '../src/index.js';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const DSN = 'postgresql://user:s3cr3t@ep-frosty-moon-123.eu-central-1.aws.neon.tech/appdb?sslmode=require';
const AAD = buildAad('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a connection string', () => {
    const payload = encryptSecret(DSN, AAD, { key: KEY });
    expect(decryptSecret(payload, AAD, { key: KEY })).toBe(DSN);
  });

  it('produces a 12-byte IV and 16-byte auth tag in hex', () => {
    const payload = encryptSecret(DSN, AAD, { key: KEY });
    expect(payload.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(payload.authTag).toMatch(/^[0-9a-f]{32}$/);
    expect(payload.keyVersion).toBe(CURRENT_KEY_VERSION);
  });

  it('never leaks the plaintext into the payload', () => {
    const payload = encryptSecret(DSN, AAD, { key: KEY });
    expect(JSON.stringify(payload)).not.toContain('s3cr3t');
    expect(payload.ciphertext).not.toContain('neon.tech');
  });

  it('uses a fresh IV for every encryption', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(encryptSecret(DSN, AAD, { key: KEY }).iv);
    }
    expect(seen.size).toBe(200);
  });

  it('rejects decryption with the wrong key', () => {
    const payload = encryptSecret(DSN, AAD, { key: KEY });
    expect(() => decryptSecret(payload, AAD, { key: OTHER_KEY })).toThrowError(InfraError);
  });

  it('rejects decryption with the wrong AAD (row swapped between apps)', () => {
    const payload = encryptSecret(DSN, AAD, { key: KEY });
    const foreignAad = buildAad('99999999-9999-4999-8999-999999999999', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(() => decryptSecret(payload, foreignAad, { key: KEY })).toThrowError(/unable to decrypt/i);
  });

  it('rejects a tampered ciphertext', () => {
    const payload = encryptSecret(DSN, AAD, { key: KEY });
    const flipped = `${payload.ciphertext.slice(0, -2)}${payload.ciphertext.endsWith('00') ? 'ff' : '00'}`;
    expect(() => decryptSecret({ ...payload, ciphertext: flipped }, AAD, { key: KEY })).toThrowError(InfraError);
  });

  it('rejects a tampered auth tag', () => {
    const payload = encryptSecret(DSN, AAD, { key: KEY });
    const tag = `${payload.authTag.slice(0, -2)}${payload.authTag.endsWith('00') ? 'ff' : '00'}`;
    expect(() => decryptSecret({ ...payload, authTag: tag }, AAD, { key: KEY })).toThrowError(InfraError);
  });

  it('rejects a malformed payload before touching the cipher', () => {
    const payload = encryptSecret(DSN, AAD, { key: KEY });
    expect(() => decryptSecret({ ...payload, iv: 'abcd' }, AAD, { key: KEY })).toThrowError(/malformed/i);
  });

  it('surfaces the error code CRYPTO_DECRYPT_FAILED', () => {
    const payload = encryptSecret(DSN, AAD, { key: KEY });
    try {
      decryptSecret(payload, 'wrong:aad', { key: KEY });
      expect.unreachable('decryption should have failed');
    } catch (error) {
      expect(InfraError.is(error)).toBe(true);
      expect((error as InfraError).code).toBe('CRYPTO_DECRYPT_FAILED');
    }
  });
});

describe('master key handling', () => {
  it('accepts a 64-character hex key', () => {
    const hex = KEY.toString('hex');
    expect(parseMasterKey(hex)).toEqual(KEY);
  });

  it('rejects a short or non-hex key without echoing it', () => {
    try {
      parseMasterKey('not-a-key');
      expect.unreachable('should reject');
    } catch (error) {
      expect((error as InfraError).code).toBe('CRYPTO_KEY_INVALID');
      expect((error as InfraError).message).not.toContain('not-a-key');
    }
  });

  it('reads the key from the environment', () => {
    const env = { INFRA_MASTER_ENCRYPTION_KEY: KEY.toString('hex') } as NodeJS.ProcessEnv;
    expect(assertMasterKey(env)).toEqual(KEY);
    expect(loadMasterKey(CURRENT_KEY_VERSION, env)).toEqual(KEY);
  });

  it('throws when the key is absent', () => {
    expect(() => assertMasterKey({} as NodeJS.ProcessEnv)).toThrowError(/is not set/);
  });

  it('names versioned env vars for rotation', () => {
    expect(masterKeyEnvVar()).toBe('INFRA_MASTER_ENCRYPTION_KEY');
    expect(masterKeyEnvVar(2)).toBe('INFRA_MASTER_ENCRYPTION_KEY_V2');
  });

  it('maps a version to the same env var regardless of which version is current', () => {
    // The invariant that makes rotation survivable: bumping the current version must not change
    // where an ALREADY-STORED ciphertext looks for its key. If version 1 started resolving to
    // _V1 the moment version 2 became current, every existing row would break at once.
    expect(masterKeyEnvVar(1)).toBe('INFRA_MASTER_ENCRYPTION_KEY');
    expect(masterKeyEnvVar(3)).toBe('INFRA_MASTER_ENCRYPTION_KEY_V3');
  });

  it('defaults to version 1 and honours the declared version', () => {
    expect(currentKeyVersion({} as NodeJS.ProcessEnv)).toBe(1);
    expect(
      currentKeyVersion({ INFRA_MASTER_ENCRYPTION_KEY_VERSION: ' 2 ' } as NodeJS.ProcessEnv),
    ).toBe(2);
  });

  it('refuses a nonsense version rather than falling back to 1', () => {
    // Falling back would write new rows with the retired key while the operator believes the
    // rotation finished — the failure mode rotation exists to prevent.
    for (const raw of ['0', '-1', '1.5', 'two']) {
      expect(() =>
        currentKeyVersion({ INFRA_MASTER_ENCRYPTION_KEY_VERSION: raw } as NodeJS.ProcessEnv),
      ).toThrowError(/whole number/);
    }
  });

  it('writes new ciphertext at the declared version, not always version 1', () => {
    const env = {
      INFRA_MASTER_ENCRYPTION_KEY: KEY.toString('hex'),
      INFRA_MASTER_ENCRYPTION_KEY_V2: OTHER_KEY.toString('hex'),
      INFRA_MASTER_ENCRYPTION_KEY_VERSION: '2',
    } as NodeJS.ProcessEnv;

    const payload = encryptSecret(DSN, AAD, { env });
    expect(payload.keyVersion).toBe(2);
    expect(decryptSecret(payload, AAD, { key: OTHER_KEY })).toBe(DSN);
    // and the retired key must NOT open it
    expect(() => decryptSecret(payload, AAD, { key: KEY })).toThrowError();
  });

  it('boots against the key it will actually write with', () => {
    const halfRotated = {
      INFRA_MASTER_ENCRYPTION_KEY: KEY.toString('hex'),
      INFRA_MASTER_ENCRYPTION_KEY_VERSION: '2',
    } as NodeJS.ProcessEnv;
    expect(() => assertMasterKey(halfRotated)).toThrowError(/INFRA_MASTER_ENCRYPTION_KEY_V2/);
  });

  it('supports decrypting with a rotated key version', () => {
    const env = {
      INFRA_MASTER_ENCRYPTION_KEY: KEY.toString('hex'),
      INFRA_MASTER_ENCRYPTION_KEY_V2: OTHER_KEY.toString('hex'),
    } as NodeJS.ProcessEnv;
    const payload = encryptSecret(DSN, AAD, { keyVersion: 2, env });
    expect(payload.keyVersion).toBe(2);
    expect(decryptSecret(payload, AAD, { env })).toBe(DSN);
  });
});
