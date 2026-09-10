/**
 * AES-256-GCM encryption for credentials stored in the Master DB
 * (tenant connection strings above all).
 *
 * Invariants:
 * - a fresh random 12-byte IV per encryption, never reused;
 * - the auth tag is stored separately and verified on decryption;
 * - AAD binds a ciphertext to one row, so rows cannot be swapped between apps;
 * - plaintext never appears in logs, errors or serialized output.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { InfraError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

export const CURRENT_KEY_VERSION = 1;
export const MASTER_KEY_ENV_VAR = 'INFRA_MASTER_ENCRYPTION_KEY';

export interface EncryptedPayload {
  /** hex-encoded ciphertext */
  ciphertext: string;
  /** hex-encoded 12-byte initialisation vector (24 chars) */
  iv: string;
  /** hex-encoded 16-byte GCM authentication tag (32 chars) */
  authTag: string;
  /** which INFRA_MASTER_ENCRYPTION_KEY generation produced this payload */
  keyVersion: number;
}

export interface EncryptOptions {
  key?: Buffer;
  keyVersion?: number;
  env?: NodeJS.ProcessEnv;
}

export interface DecryptOptions {
  key?: Buffer;
  env?: NodeJS.ProcessEnv;
}

export function masterKeyEnvVar(keyVersion: number = CURRENT_KEY_VERSION): string {
  return keyVersion === CURRENT_KEY_VERSION
    ? MASTER_KEY_ENV_VAR
    : `${MASTER_KEY_ENV_VAR}_V${keyVersion}`;
}

/** Validates a hex master key without ever echoing its value. */
export function parseMasterKey(raw: string, source: string = MASTER_KEY_ENV_VAR): Buffer {
  const value = raw.trim();
  if (!HEX_64.test(value)) {
    throw new InfraError(
      'CRYPTO_KEY_INVALID',
      `${source} must be 32 bytes encoded as 64 hexadecimal characters (generate with: openssl rand -hex 32)`,
      { details: { source, receivedLength: value.length } },
    );
  }
  return Buffer.from(value, 'hex');
}

export function loadMasterKey(
  keyVersion: number = CURRENT_KEY_VERSION,
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const source = masterKeyEnvVar(keyVersion);
  const raw = env[source];
  if (raw === undefined || raw === '') {
    throw new InfraError('CRYPTO_KEY_INVALID', `${source} is not set`, { details: { source } });
  }
  return parseMasterKey(raw, source);
}

/** Call once at boot so a misconfigured deployment fails immediately. */
export function assertMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  return loadMasterKey(CURRENT_KEY_VERSION, env);
}

/** Binds a ciphertext to the exact row that owns it. */
export function buildAad(appId: string, configId: string): string {
  return `${appId}:${configId}`;
}

function resolveKey(explicit: Buffer | undefined, keyVersion: number, env: NodeJS.ProcessEnv): Buffer {
  if (explicit === undefined) return loadMasterKey(keyVersion, env);
  if (explicit.length !== KEY_BYTES) {
    throw new InfraError('CRYPTO_KEY_INVALID', `encryption key must be exactly ${KEY_BYTES} bytes`, {
      details: { receivedBytes: explicit.length },
    });
  }
  return explicit;
}

export function encryptSecret(
  plaintext: string,
  aad: string,
  options: EncryptOptions = {},
): EncryptedPayload {
  const keyVersion = options.keyVersion ?? CURRENT_KEY_VERSION;
  const key = resolveKey(options.key, keyVersion, options.env ?? process.env);
  const iv = randomBytes(IV_BYTES);

  try {
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('hex'),
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
      keyVersion,
    };
  } catch (cause) {
    throw new InfraError('CRYPTO_ENCRYPT_FAILED', 'unable to encrypt secret', { cause });
  }
}

export function decryptSecret(
  payload: EncryptedPayload,
  aad: string,
  options: DecryptOptions = {},
): string {
  const key = resolveKey(options.key, payload.keyVersion, options.env ?? process.env);

  if (payload.iv.length !== IV_BYTES * 2 || payload.authTag.length !== AUTH_TAG_BYTES * 2) {
    throw new InfraError('CRYPTO_DECRYPT_FAILED', 'encrypted payload is malformed', {
      details: { ivLength: payload.iv.length, authTagLength: payload.authTag.length },
    });
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'hex'), {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'hex')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch (cause) {
    // Deliberately vague: wrong key, wrong AAD and tampering are indistinguishable to the caller.
    throw new InfraError(
      'CRYPTO_DECRYPT_FAILED',
      'unable to decrypt secret (wrong key, wrong context or tampered ciphertext)',
      { cause, details: { keyVersion: payload.keyVersion } },
    );
  }
}
