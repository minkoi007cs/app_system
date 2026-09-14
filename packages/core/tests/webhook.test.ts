import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildEvent,
  generateWebhookSecret,
  isPublicHttpUrl,
  isWebhookEventType,
  MAX_DELIVERY_ATTEMPTS,
  nextAttemptAt,
  parseSignatureHeader,
  retryDelayMs,
  RETRY_MAX_MS,
  shouldRetry,
  signingPayload,
  signWebhook,
  SIGNATURE_TOLERANCE_SECONDS,
  verifyWebhook,
  WEBHOOK_SECRET_PREFIX,
} from '../src/webhook.js';

const SECRET = 'whsec_test_secret_value_0123456789';
const BODY = JSON.stringify({ id: 'evt_1', type: 'user.created' });
const NOW = new Date('2026-09-13T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

describe('signing', () => {
  it('signs timestamp and body together, not the body alone', () => {
    const header = signWebhook(SECRET, BODY, NOW_SECONDS);
    const expected = createHmac('sha256', SECRET)
      .update(`${NOW_SECONDS}.${BODY}`, 'utf8')
      .digest('hex');
    expect(header).toBe(`t=${NOW_SECONDS},v1=${expected}`);
    expect(signingPayload(NOW_SECONDS, BODY)).toBe(`${NOW_SECONDS}.${BODY}`);
  });

  it('verifies a signature it just produced', () => {
    const header = signWebhook(SECRET, BODY, NOW_SECONDS);
    expect(verifyWebhook(SECRET, BODY, header, { now: NOW })).toBe(true);
  });

  it('refuses a body that was edited in transit', () => {
    const header = signWebhook(SECRET, BODY, NOW_SECONDS);
    expect(verifyWebhook(SECRET, `${BODY} `, header, { now: NOW })).toBe(false);
  });

  it('refuses the wrong secret', () => {
    const header = signWebhook(SECRET, BODY, NOW_SECONDS);
    expect(verifyWebhook('whsec_someone_elses_secret_0000000', BODY, header, { now: NOW })).toBe(false);
  });

  it('refuses a replay once the tolerance window has passed', () => {
    const header = signWebhook(SECRET, BODY, NOW_SECONDS);
    const later = new Date(NOW.getTime() + (SIGNATURE_TOLERANCE_SECONDS + 1) * 1000);
    expect(verifyWebhook(SECRET, BODY, header, { now: later })).toBe(false);
  });

  it('refuses a timestamp from the future as readily as one from the past', () => {
    const ahead = signWebhook(SECRET, BODY, NOW_SECONDS + SIGNATURE_TOLERANCE_SECONDS + 60);
    expect(verifyWebhook(SECRET, BODY, ahead, { now: NOW })).toBe(false);
  });

  it('cannot be replayed by editing the timestamp — it is inside the signed material', () => {
    const header = signWebhook(SECRET, BODY, NOW_SECONDS - 10_000);
    const forged = header.replace(/^t=\d+/, `t=${NOW_SECONDS}`);
    expect(verifyWebhook(SECRET, BODY, forged, { now: NOW })).toBe(false);
  });

  it('accepts either signature during a secret rotation', () => {
    const old = signWebhook(SECRET, BODY, NOW_SECONDS).split('v1=')[1] ?? '';
    const fresh = signWebhook('whsec_rotated_value_00000000000000', BODY, NOW_SECONDS).split('v1=')[1] ?? '';
    const header = `t=${NOW_SECONDS},v1=${old},v1=${fresh}`;
    expect(verifyWebhook(SECRET, BODY, header, { now: NOW })).toBe(true);
    expect(verifyWebhook('whsec_rotated_value_00000000000000', BODY, header, { now: NOW })).toBe(true);
  });

  it('refuses malformed headers rather than throwing', () => {
    for (const header of ['', 'garbage', 't=abc,v1=def', `t=${NOW_SECONDS}`, 'v1=deadbeef']) {
      expect(verifyWebhook(SECRET, BODY, header, { now: NOW })).toBe(false);
    }
  });

  it('parses a well-formed header', () => {
    expect(parseSignatureHeader(`t=${NOW_SECONDS},v1=aa,v1=bb`)).toEqual({
      timestamp: NOW_SECONDS,
      signatures: ['aa', 'bb'],
    });
  });

  it('generates prefixed secrets that never repeat', () => {
    const secrets = new Set(Array.from({ length: 200 }, () => generateWebhookSecret()));
    expect(secrets.size).toBe(200);
    expect([...secrets].every((value) => value.startsWith(WEBHOOK_SECRET_PREFIX))).toBe(true);
  });
});

describe('events', () => {
  it('stamps an id, the app and an ISO timestamp', () => {
    const event = buildEvent('user.created', 'app-1', { userId: 'u1' }, NOW);
    expect(event.id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(event.appId).toBe('app-1');
    expect(event.createdAt).toBe(NOW.toISOString());
  });

  it('recognises only known event types', () => {
    expect(isWebhookEventType('user.created')).toBe(true);
    expect(isWebhookEventType('user.exploded')).toBe(false);
  });
});

describe('retries', () => {
  it('backs off and then caps', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(480_000);
    expect(retryDelayMs(50)).toBe(RETRY_MAX_MS);
  });

  it('stops scheduling once the attempt budget is spent', () => {
    expect(nextAttemptAt(MAX_DELIVERY_ATTEMPTS - 1, NOW)).not.toBeNull();
    expect(nextAttemptAt(MAX_DELIVERY_ATTEMPTS, NOW)).toBeNull();
  });

  it('retries what is worth retrying and gives up on what is not', () => {
    expect(shouldRetry(200)).toBe(false);
    expect(shouldRetry(204)).toBe(false);
    expect(shouldRetry(400)).toBe(false);
    expect(shouldRetry(404)).toBe(false);
    expect(shouldRetry(408)).toBe(true);
    expect(shouldRetry(429)).toBe(true);
    expect(shouldRetry(500)).toBe(true);
    expect(shouldRetry(503)).toBe(true);
    expect(shouldRetry(null)).toBe(true);
  });
});

describe('isPublicHttpUrl — the ssrf guard', () => {
  it('accepts an ordinary https endpoint', () => {
    expect(isPublicHttpUrl('https://hooks.example.com/infra').ok).toBe(true);
    expect(isPublicHttpUrl('https://example.com:443/x').ok).toBe(true);
  });

  it('refuses the cloud metadata endpoint', () => {
    expect(isPublicHttpUrl('https://169.254.169.254/latest/meta-data/').ok).toBe(false);
    expect(isPublicHttpUrl('https://metadata.google.internal/x').ok).toBe(false);
  });

  it('refuses loopback and private ranges', () => {
    for (const url of [
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://10.1.2.3/x',
      'https://192.168.0.5/x',
      'https://172.16.9.9/x',
      'https://100.64.3.1/x',
      'https://0.0.0.0/x',
      'https://[::1]/x',
    ]) {
      expect(isPublicHttpUrl(url).ok, url).toBe(false);
    }
  });

  it('refuses plain http, odd ports, and credentials in the url', () => {
    expect(isPublicHttpUrl('http://example.com/x').ok).toBe(false);
    expect(isPublicHttpUrl('https://example.com:8443/x').ok).toBe(false);
    expect(isPublicHttpUrl('https://user:pass@example.com/x').ok).toBe(false);
  });

  it('refuses non-http schemes and malformed input', () => {
    for (const url of ['file:///etc/passwd', 'gopher://x', 'not a url', '']) {
      expect(isPublicHttpUrl(url).ok, url).toBe(false);
    }
  });

  it('refuses internal-looking names', () => {
    expect(isPublicHttpUrl('https://db.internal/x').ok).toBe(false);
    expect(isPublicHttpUrl('https://printer.local/x').ok).toBe(false);
  });

  it('gives a reason without echoing the url back', () => {
    const verdict = isPublicHttpUrl('http://127.0.0.1/secret-path');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).not.toContain('secret-path');
  });
});
