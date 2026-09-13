/**
 * TOTP (RFC 6238) on top of HOTP (RFC 4226), implemented on node:crypto.
 *
 * Hand-rolled for the same reason as the JWT module: this is 60 lines of well-specified maths,
 * it is verified against the RFC's own test vectors, and it keeps a dependency out of the
 * authentication path. Everything an authenticator app needs is here — base32, the otpauth URI,
 * a drift window, and single-use backup codes.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** ±1 step: tolerates a phone clock that is up to 30 seconds out either way. */
export const TOTP_DEFAULT_WINDOW = 1;

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ── base32 (RFC 4648, no padding — what authenticator apps expect) ───────────

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[=\s]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── HOTP / TOTP ──────────────────────────────────────────────────────────────

export interface TotpOptions {
  digits?: number;
  stepSeconds?: number;
  algorithm?: TotpAlgorithm;
}

/** RFC 4226 §5.3 — HMAC, dynamic truncation, modulo 10^digits. */
export function hotpCode(secret: Buffer, counter: number, options: TotpOptions = {}): string {
  const digits = options.digits ?? TOTP_DIGITS;

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(options.algorithm ?? 'sha1', secret).update(counterBuffer).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function totpCode(
  secretBase32: string,
  atMilliseconds: number = Date.now(),
  options: TotpOptions = {},
): string {
  const step = options.stepSeconds ?? TOTP_STEP_SECONDS;
  const counter = Math.floor(atMilliseconds / 1000 / step);
  return hotpCode(base32Decode(secretBase32), counter, options);
}

export interface VerifyTotpOptions extends TotpOptions {
  /** How many steps either side of now to accept. */
  window?: number;
  atMilliseconds?: number;
}

/**
 * Constant-time comparison across the drift window.
 * Returns the matched step offset so a caller can store it and reject replay of the same step.
 */
export function verifyTotp(
  code: string,
  secretBase32: string,
  options: VerifyTotpOptions = {},
): { valid: boolean; offset: number | null } {
  const digits = options.digits ?? TOTP_DIGITS;
  const candidate = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return { valid: false, offset: null };

  const window = options.window ?? TOTP_DEFAULT_WINDOW;
  const at = options.atMilliseconds ?? Date.now();
  const step = options.stepSeconds ?? TOTP_STEP_SECONDS;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(at / 1000 / step);

  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = hotpCode(secret, counter + offset, options);
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    // Never short-circuit: keep scanning the whole window so timing does not leak the offset.
    if (a.length === b.length && timingSafeEqual(a, b) && matched === null) matched = offset;
  }

  return { valid: matched !== null, offset: matched };
}

// ── enrolment ────────────────────────────────────────────────────────────────

export interface TotpSecret {
  /** base32, what the user types into their authenticator app. */
  base32: string;
  /** otpauth:// URI — what a QR code would encode. */
  uri: string;
}

export interface OtpAuthInput {
  secretBase32: string;
  accountName: string;
  issuer: string;
  digits?: number;
  stepSeconds?: number;
  algorithm?: TotpAlgorithm;
}

export function otpauthUri(input: OtpAuthInput): string {
  const label = encodeURIComponent(`${input.issuer}:${input.accountName}`);
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: (input.algorithm ?? 'sha1').toUpperCase(),
    digits: String(input.digits ?? TOTP_DIGITS),
    period: String(input.stepSeconds ?? TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** 20 random bytes — the size RFC 4226 recommends for a SHA-1 HOTP secret. */
export function generateTotpSecret(input: Omit<OtpAuthInput, 'secretBase32'>): TotpSecret {
  const base32 = base32Encode(randomBytes(20));
  return { base32, uri: otpauthUri({ ...input, secretBase32: base32 }) };
}

// ── backup codes ─────────────────────────────────────────────────────────────

export const BACKUP_CODE_COUNT = 10;

export interface BackupCodes {
  /** Shown once, at enrolment. */
  codes: string[];
  /** What gets stored. */
  hashes: string[];
}

export function hashBackupCode(code: string): string {
  return createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase(), 'utf8').digest('hex');
}

/** Human-transcribable: no O/0/I/1 confusion, grouped as XXXX-XXXX. */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): BackupCodes {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];

  for (let index = 0; index < count; index += 1) {
    let raw = '';
    for (let position = 0; position < 8; position += 1) {
      raw += alphabet.charAt(randomInt(alphabet.length));
    }
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }

  return { codes, hashes: codes.map(hashBackupCode) };
}

/** Matches a supplied code against stored hashes; returns which one, so it can be burned. */
export function findBackupCodeMatch(code: string, storedHashes: readonly string[]): number {
  const candidate = hashBackupCode(code);
  return storedHashes.findIndex((stored) => {
    const a = Buffer.from(stored);
    const b = Buffer.from(candidate);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
