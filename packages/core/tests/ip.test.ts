import { describe, expect, it } from 'vitest';
import { ipAllowed, ipMatches, parseCidr, parseIpv4 } from '../src/index.js';

describe('parseIpv4', () => {
  it('parses valid addresses', () => {
    expect(parseIpv4('0.0.0.0')).toBe(0);
    expect(parseIpv4('255.255.255.255')).toBe(4294967295);
    expect(parseIpv4('192.168.1.1')).toBe(3232235777);
  });

  it('returns null for anything malformed — never a lenient guess', () => {
    for (const junk of ['', '1.2.3', '1.2.3.4.5', '256.0.0.1', 'a.b.c.d', '1.2.3.-1', ' 1.2.3.04x']) {
      expect(parseIpv4(junk)).toBeNull();
    }
  });
});

describe('parseCidr', () => {
  it('treats a bare address as /32', () => {
    expect(parseCidr('10.0.0.1')).toEqual({ base: parseIpv4('10.0.0.1'), mask: 0xffffffff });
  });

  it('masks the base address', () => {
    const parsed = parseCidr('10.1.2.3/24');
    expect(parsed?.base).toBe(parseIpv4('10.1.2.0'));
  });

  it('handles /0 without shifting by 32', () => {
    expect(parseCidr('0.0.0.0/0')).toEqual({ base: 0, mask: 0 });
  });

  it('rejects an invalid prefix length', () => {
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('10.0.0.0/abc')).toBeNull();
  });
});

describe('ipMatches', () => {
  it('matches inside a range and not outside it', () => {
    expect(ipMatches('10.1.2.55', '10.1.2.0/24')).toBe(true);
    expect(ipMatches('10.1.3.55', '10.1.2.0/24')).toBe(false);
  });

  it('matches an exact address', () => {
    expect(ipMatches('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(ipMatches('203.0.113.8', '203.0.113.7')).toBe(false);
  });

  it('falls back to an exact comparison for ipv6', () => {
    expect(ipMatches('2001:db8::1', '2001:db8::1')).toBe(true);
    expect(ipMatches('2001:db8::2', '2001:db8::1')).toBe(false);
  });

  it('a malformed entry matches nothing rather than everything', () => {
    expect(ipMatches('10.0.0.1', 'not-an-ip')).toBe(false);
    expect(ipMatches('10.0.0.1', '')).toBe(false);
  });
});

describe('ipAllowed', () => {
  it('an empty allowlist means unrestricted', () => {
    expect(ipAllowed('10.0.0.1', [])).toBe(true);
    expect(ipAllowed(null, [])).toBe(true);
  });

  it('a populated allowlist refuses an unknown address', () => {
    expect(ipAllowed('10.0.0.1', ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('203.0.113.9', ['203.0.113.0/24'])).toBe(true);
  });

  it('refuses when the caller IP is unknown but a list exists', () => {
    // Not knowing where a call came from is not a reason to let it through.
    expect(ipAllowed(null, ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('', ['203.0.113.0/24'])).toBe(false);
  });
});
