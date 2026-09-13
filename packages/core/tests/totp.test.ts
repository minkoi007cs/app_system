import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  findBackupCodeMatch,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  hotpCode,
  otpauthUri,
  totpCode,
  verifyTotp,
} from '../src/index.js';

/** RFC 4648 §10 test vectors. */
describe('base32', () => {
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  it.each(vectors)('encodes %j', (input, expected) => {
    expect(base32Encode(Buffer.from(input))).toBe(expected);
  });

  it.each(vectors)('decodes back to %j', (expected, encoded) => {
    expect(base32Decode(encoded).toString()).toBe(expected);
  });

  it('rejects an invalid character', () => {
    expect(() => base32Decode('MZXW6!')).toThrowError(/invalid base32/);
  });
});

/** RFC 4226 Appendix D — HOTP with the ASCII secret "12345678901234567890". */
describe('hotpCode — RFC 4226 vectors', () => {
  const secret = Buffer.from('12345678901234567890');
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];

  it.each(expected.map((code, counter) => [counter, code] as const))(
    'counter %i produces %s',
    (counter, code) => {
      expect(hotpCode(secret, counter)).toBe(code);
    },
  );
});

/** RFC 6238 Appendix B — 8-digit TOTP, SHA-1, same ASCII secret. */
describe('totpCode — RFC 6238 vectors', () => {
  const secretBase32 = base32Encode(Buffer.from('12345678901234567890'));
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(vectors)('at T=%i produces %s', (seconds, code) => {
    expect(totpCode(secretBase32, seconds * 1000, { digits: 8 })).toBe(code);
  });
});

describe('verifyTotp', () => {
  const secret = generateTotpSecret({ accountName: 'khoi@example.com', issuer: 'Unified-App-Infra' });
  const now = 1_800_000_000_000;

  it('accepts the current code', () => {
    const code = totpCode(secret.base32, now);
    expect(verifyTotp(code, secret.base32, { atMilliseconds: now })).toEqual({ valid: true, offset: 0 });
  });

  it('tolerates one step of clock drift either way', () => {
    const early = totpCode(secret.base32, now - 30_000);
    const late = totpCode(secret.base32, now + 30_000);
    expect(verifyTotp(early, secret.base32, { atMilliseconds: now }).offset).toBe(-1);
    expect(verifyTotp(late, secret.base32, { atMilliseconds: now }).offset).toBe(1);
  });

  it('rejects a code two steps out', () => {
    const stale = totpCode(secret.base32, now - 90_000);
    expect(verifyTotp(stale, secret.base32, { atMilliseconds: now }).valid).toBe(false);
  });

  it('rejects another secret', () => {
    const other = generateTotpSecret({ accountName: 'a@b.c', issuer: 'x' });
    const code = totpCode(other.base32, now);
    expect(verifyTotp(code, secret.base32, { atMilliseconds: now }).valid).toBe(false);
  });

  it('rejects malformed input without touching the cipher', () => {
    for (const junk of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
      expect(verifyTotp(junk, secret.base32, { atMilliseconds: now }).valid).toBe(false);
    }
  });

  it('ignores spaces a user pastes in', () => {
    const code = totpCode(secret.base32, now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(spaced, secret.base32, { atMilliseconds: now }).valid).toBe(true);
  });
});

describe('enrolment', () => {
  it('produces a 32-character base32 secret and an otpauth uri', () => {
    const secret = generateTotpSecret({ accountName: 'khoi@example.com', issuer: 'Unified-App-Infra' });
    expect(secret.base32).toMatch(/^[A-Z2-7]{32}$/);
    expect(secret.uri).toContain('otpauth://totp/');
    expect(secret.uri).toContain(`secret=${secret.base32}`);
    expect(secret.uri).toContain('issuer=Unified-App-Infra');
    expect(secret.uri).toContain('period=30');
  });

  it('escapes the label', () => {
    const uri = otpauthUri({ secretBase32: 'AAAA', accountName: 'a b@c.d', issuer: 'My Infra' });
    expect(uri).toContain('otpauth://totp/My%20Infra%3Aa%20b%40c.d');
  });

  it('never repeats a secret', () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => generateTotpSecret({ accountName: 'a', issuer: 'b' }).base32),
    );
    expect(seen.size).toBe(200);
  });
});

describe('backup codes', () => {
  it('generates ten transcribable codes with their hashes', () => {
    const { codes, hashes } = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(hashes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it('omits characters people confuse', () => {
    const { codes } = generateBackupCodes(100);
    expect(codes.join('')).not.toMatch(/[OI01]/);
  });

  it('stores only hashes', () => {
    const { codes, hashes } = generateBackupCodes();
    for (const [index, code] of codes.entries()) {
      expect(hashes[index]).toBe(hashCode(code));
      expect(hashes[index]).not.toContain(code);
    }
  });

  it('matches a code regardless of dashes and case', () => {
    const { codes, hashes } = generateBackupCodes();
    const target = codes[3] as string;
    expect(findBackupCodeMatch(target, hashes)).toBe(3);
    expect(findBackupCodeMatch(target.replace('-', '').toLowerCase(), hashes)).toBe(3);
  });

  it('returns -1 for a code that was never issued', () => {
    const { hashes } = generateBackupCodes();
    expect(findBackupCodeMatch('AAAA-BBBB', hashes)).toBe(-1);
  });
});

function hashCode(code: string): string {
  return hashBackupCode(code);
}
