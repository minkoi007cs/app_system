/**
 * IP allowlists for service accounts.
 *
 * Supports exact addresses and IPv4 CIDR ranges. An empty allowlist means "anywhere" — that is a
 * deliberate default so adding the feature does not silently lock existing integrations out, and
 * the dashboard says so next to the field.
 */

export interface ParsedCidr {
  base: number;
  mask: number;
}

/** Returns null rather than throwing: a malformed entry must never widen access. */
export function parseIpv4(address: string): number | null {
  const parts = address.trim().split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

export function parseCidr(entry: string): ParsedCidr | null {
  const [address, bitsRaw] = entry.trim().split('/');
  if (address === undefined) return null;

  const base = parseIpv4(address);
  if (base === null) return null;

  if (bitsRaw === undefined) return { base, mask: 0xffffffff };
  if (!/^\d{1,2}$/.test(bitsRaw)) return null;

  const bits = Number(bitsRaw);
  if (bits > 32) return null;
  // A /0 mask would match everything; shifting by 32 is undefined in JS, so handle it explicitly.
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

export function ipMatches(ip: string, entry: string): boolean {
  const trimmed = entry.trim();
  if (trimmed === '') return false;

  // IPv6 and anything we cannot parse falls back to an exact, case-insensitive comparison.
  const cidr = parseCidr(trimmed);
  if (cidr === null) return ip.trim().toLowerCase() === trimmed.toLowerCase();

  const value = parseIpv4(ip);
  if (value === null) return false;
  return ((value & cidr.mask) >>> 0) === cidr.base;
}

/** Empty allowlist = unrestricted. Any entry present means the IP must match one of them. */
export function ipAllowed(ip: string | null, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  if (ip === null || ip.trim() === '') return false;
  return allowlist.some((entry) => ipMatches(ip, entry));
}
