/**
 * Outbound identity webhooks: envelope, signature, retry schedule, and the SSRF guard.
 *
 * A webhook is the platform making an HTTP request to a URL a tenant chose. That sentence contains
 * two problems, and this file is the answer to both.
 *
 * 1. The receiver has to know the request really came from us, and is not a replay. Answer: an
 *    HMAC-SHA256 over `timestamp.body` — the timestamp is inside the signed material, so it cannot
 *    be edited to widen the replay window — sent as `t=<unix>,v1=<hex>`, verified in constant time
 *    against a window. Signing the body alone is the classic mistake: it makes every delivery
 *    replayable forever.
 *
 * 2. We are making a request to an address the tenant controls, from inside our own network. That
 *    is server-side request forgery by construction. Answer: `isPublicHttpUrl` — https only,
 *    default ports, and no loopback, link-local, private or CGNAT destination. 169.254.169.254 is
 *    the cloud metadata endpoint, and "make the platform fetch it for me" is how credentials leave.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseIpv4 } from './ip.js';

export const WEBHOOK_SECRET_PREFIX = 'whsec_';
export const SIGNATURE_HEADER = 'x-infra-signature';
export const EVENT_ID_HEADER = 'x-infra-event-id';
/** Deliveries older than this are refused by a correct receiver. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const WEBHOOK_EVENT_TYPES = [
  'user.created',
  'user.signed_in',
  'user.suspended',
  'user.reinstated',
  'user.offboarded',
  'user.password_reset',
  'session.revoked',
  'member.invited',
  'member.joined',
  'service_account.revoked',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export interface WebhookEvent<T = Record<string, unknown>> {
  id: string;
  type: WebhookEventType;
  /** Which app the event belongs to. A receiver should refuse anything it does not recognise. */
  appId: string;
  createdAt: string;
  data: T;
}

export function buildEvent<T extends Record<string, unknown>>(
  type: WebhookEventType,
  appId: string,
  data: T,
  now: Date = new Date(),
): WebhookEvent<T> {
  return { id: `evt_${randomUUID().replace(/-/g, '')}`, type, appId, createdAt: now.toISOString(), data };
}

// ── signing ──────────────────────────────────────────────────────────────────

export function generateWebhookSecret(): string {
  // 32 bytes, same shape as every other secret here: shown once, stored encrypted.
  return `${WEBHOOK_SECRET_PREFIX}${Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43)}`;
}

/** The exact bytes that get signed. Exported because the receiver has to reproduce them. */
export function signingPayload(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`;
}

export function signWebhook(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret).update(signingPayload(timestampSeconds, body), 'utf8').digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

export interface SignatureParts {
  timestamp: number;
  signatures: string[];
}

/** Tolerates several v1 values so a secret can be rotated without dropping deliveries. */
export function parseSignatureHeader(header: string): SignatureParts | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const segment of header.split(',')) {
    const [key, value] = segment.trim().split('=');
    if (key === undefined || value === undefined) continue;
    if (key === 't') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export interface VerifyWebhookOptions {
  toleranceSeconds?: number;
  now?: Date;
}

/**
 * What a child app runs on its receiving end. Lives here rather than in the SDK so the hub's own
 * tests exercise exactly the code a tenant will run.
 */
export function verifyWebhook(
  secret: string,
  body: string,
  header: string,
  options: VerifyWebhookOptions = {},
): boolean {
  const parts = parseSignatureHeader(header);
  if (parts === null) return false;

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  // Absolute difference: a timestamp from the future is as suspect as one from the past.
  if (Math.abs(nowSeconds - parts.timestamp) > tolerance) return false;

  const expected = createHmac('sha256', secret)
    .update(signingPayload(parts.timestamp, body), 'utf8')
    .digest();

  return parts.signatures.some((candidate) => {
    const provided = Buffer.from(candidate, 'hex');
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  });
}

// ── retries ──────────────────────────────────────────────────────────────────

export const MAX_DELIVERY_ATTEMPTS = 6;
/** ~30s, 2m, 8m, 32m, 2h — capped, and the last one is far enough out to outlive a deploy. */
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

export function retryDelayMs(attempt: number): number {
  if (attempt < 1) return 0;
  const doublings = Math.min(attempt - 1, 20);
  return Math.min(RETRY_BASE_MS * 4 ** doublings, RETRY_MAX_MS);
}

export function nextAttemptAt(attempt: number, now: Date = new Date()): Date | null {
  if (attempt >= MAX_DELIVERY_ATTEMPTS) return null;
  return new Date(now.getTime() + retryDelayMs(attempt));
}

/** 2xx is delivered. 4xx other than 408/429 is the receiver saying "never send this again". */
export function shouldRetry(statusCode: number | null): boolean {
  if (statusCode === null) return true; // network error, timeout — try again
  if (statusCode >= 200 && statusCode < 300) return false;
  if (statusCode === 408 || statusCode === 429) return true;
  return statusCode >= 500;
}

// ── SSRF guard ───────────────────────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'instance-data']);

/** RFC1918 + loopback + link-local + CGNAT, as CIDRs so the check reads like the RFC. */
const BLOCKED_V4_RANGES: readonly string[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

function inBlockedRange(ip: string): boolean {
  const value = parseIpv4(ip);
  if (value === null) return false;

  return BLOCKED_V4_RANGES.some((entry) => {
    const [base, bitsRaw] = entry.split('/');
    const baseValue = parseIpv4(base ?? '');
    if (baseValue === null) return false;
    const bits = Number(bitsRaw ?? '32');
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
  });
}

export interface UrlVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Refuses anything that is not a plain https endpoint on the public internet.
 *
 * This is a literal check on the URL, not a DNS resolution — a hostname can still resolve to a
 * private address (DNS rebinding). The dispatcher therefore also refuses redirects, so a public
 * host cannot bounce the request inward, and deployments that need the stronger guarantee should
 * egress webhooks through a proxy that pins the resolved address.
 */
export function isPublicHttpUrl(raw: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed url' };
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'webhook urls must use https' };
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials in the url are not accepted' };
  }
  if (url.port !== '' && url.port !== '443') return { ok: false, reason: 'only port 443 is accepted' };

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname)) return { ok: false, reason: 'that host is not routable' };
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { ok: false, reason: 'that host is not routable' };
  }
  // IPv6 loopback and unique-local; IPv4 handled by the range table.
  if (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd')) {
    return { ok: false, reason: 'that host is not routable' };
  }
  if (inBlockedRange(hostname)) return { ok: false, reason: 'that host is not routable' };

  return { ok: true };
}
