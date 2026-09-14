import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assessPassword,
  assessPasswordLocally,
  countBreachesInRange,
  hibpRange,
  lookupBreachCount,
  MIN_PASSWORD_LENGTH,
} from '../src/password.js';

const sha1 = (value: string): string =>
  createHash('sha1').update(value, 'utf8').digest('hex').toUpperCase();

/** A fetch stand-in that returns a fixed body, so no test ever touches the network. */
function stubFetch(body: string, status = 200) {
  return async (): Promise<Response> => new Response(body, { status });
}

describe('hibpRange', () => {
  it('splits the sha-1 at five characters — the published k-anonymity boundary', () => {
    const { prefix, suffix } = hibpRange('password');
    const digest = sha1('password');
    expect(digest).toBe('5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8');
    expect(prefix).toBe('5BAA6');
    expect(suffix).toBe('1E4C9B93F3F0682250B6CF8331B7EE68FD8');
    expect(prefix + suffix).toBe(digest);
  });

  it('sends five characters and keeps thirty-five', () => {
    const { prefix, suffix } = hibpRange('a-completely-different-password');
    expect(prefix).toHaveLength(5);
    expect(suffix).toHaveLength(35);
  });
});

describe('countBreachesInRange', () => {
  const suffix = hibpRange('password').suffix;

  it('finds the count for a matching suffix', () => {
    expect(countBreachesInRange(`${suffix}:12345`, suffix)).toBe(12_345);
  });

  it('handles the CRLF line endings the service actually returns', () => {
    const body = `0000000000000000000000000000000000A:3\r\n${suffix}:9\r\n0000000000000000000000000000000000B:4\r\n`;
    expect(countBreachesInRange(body, suffix)).toBe(9);
  });

  it('reads a padding entry as not-found, not as found-zero-times', () => {
    // With Add-Padding the service mixes in decoys whose count is 0. If a decoy read as a hit,
    // padded and unpadded responses would be distinguishable — which is the point of padding.
    expect(countBreachesInRange(`${suffix}:0`, suffix)).toBe(0);
  });

  it('returns zero when the suffix is absent', () => {
    expect(countBreachesInRange('AAAA:5\nBBBB:7', suffix)).toBe(0);
    expect(countBreachesInRange('', suffix)).toBe(0);
  });

  it('matches regardless of the case the service replies in', () => {
    expect(countBreachesInRange(`${suffix.toLowerCase()}:42`, suffix)).toBe(42);
  });

  it('ignores malformed lines instead of throwing', () => {
    expect(countBreachesInRange(`garbage\n\n${suffix}:8`, suffix)).toBe(8);
  });
});

describe('lookupBreachCount', () => {
  it('returns the count the range reports', async () => {
    const { suffix } = hibpRange('password');
    const count = await lookupBreachCount('password', { fetchImpl: stubFetch(`${suffix}:1000`) });
    expect(count).toBe(1_000);
  });

  it('never sends the password or its full digest', async () => {
    const seen: string[] = [];
    await lookupBreachCount('correct horse battery staple', {
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response('', { status: 200 });
      },
    });
    const url = seen[0] ?? '';
    expect(url).not.toContain('correct');
    expect(url.split('/range/')[1]).toHaveLength(5);
  });

  it('fails open on a non-200 — a third-party outage must not block sign-up', async () => {
    expect(await lookupBreachCount('x', { fetchImpl: stubFetch('', 503) })).toBeNull();
  });

  it('fails open when the request throws', async () => {
    const count = await lookupBreachCount('x', {
      fetchImpl: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(count).toBeNull();
  });
});

describe('assessPasswordLocally', () => {
  it('refuses anything under the minimum length', () => {
    const problems = assessPasswordLocally('short');
    expect(problems.map((p) => p.code)).toContain('too_short');
    expect('x'.repeat(MIN_PASSWORD_LENGTH).length).toBe(MIN_PASSWORD_LENGTH);
  });

  it('refuses an absurdly long password rather than letting a hash truncate it', () => {
    expect(assessPasswordLocally('a1B!'.repeat(200)).map((p) => p.code)).toContain('too_long');
  });

  it('refuses well-known shapes', () => {
    for (const value of ['aaaaaaaaaaaaaa', 'password12345678', 'qwertyuiop1234']) {
      expect(assessPasswordLocally(value).map((p) => p.code)).toContain('too_simple');
    }
  });

  it('refuses a password built from the address it protects', () => {
    const problems = assessPasswordLocally('Khoi-Hoang-2026!', ['khoi.hoang@example.com', 'Khoi Hoang']);
    expect(problems.map((p) => p.code)).toContain('contains_identifier');
  });

  it('ignores identifiers too short to be meaningful', () => {
    expect(assessPasswordLocally('Th3-quick-br0wn-f0x', ['a@b.co']).map((p) => p.code)).not.toContain(
      'contains_identifier',
    );
  });

  it('accepts a reasonable passphrase', () => {
    expect(assessPasswordLocally('Th3-quick-br0wn-f0x-jumps', ['someone@example.com'])).toEqual([]);
  });
});

describe('assessPassword', () => {
  const GOOD = 'Th3-quick-br0wn-f0x-jumps';

  it('accepts a passphrase the corpus has never seen', async () => {
    const result = await assessPassword(GOOD, { fetchImpl: stubFetch('') });
    expect(result.ok).toBe(true);
    expect(result.breachCount).toBe(0);
    expect(result.breachCheckPerformed).toBe(true);
  });

  it('refuses a passphrase the corpus has seen even once', async () => {
    const { suffix } = hibpRange(GOOD);
    const result = await assessPassword(GOOD, { fetchImpl: stubFetch(`${suffix}:1`) });
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toEqual(['breached']);
    expect(result.breachCount).toBe(1);
  });

  it('accepts when the lookup could not run, and says so', async () => {
    const result = await assessPassword(GOOD, { fetchImpl: stubFetch('', 500) });
    expect(result.ok).toBe(true);
    expect(result.breachCount).toBeNull();
    expect(result.breachCheckPerformed).toBe(false);
  });

  it('does not spend a round trip on a password a local rule already refused', async () => {
    let calls = 0;
    const result = await assessPassword('short', {
      fetchImpl: async () => {
        calls += 1;
        return new Response('');
      },
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('honours checkBreaches: false for an air-gapped deployment', async () => {
    let calls = 0;
    const result = await assessPassword(GOOD, {
      checkBreaches: false,
      fetchImpl: async () => {
        calls += 1;
        return new Response('');
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it('never puts the password itself into a problem message', async () => {
    const { suffix } = hibpRange(GOOD);
    const result = await assessPassword(GOOD, { fetchImpl: stubFetch(`${suffix}:5`) });
    for (const problem of result.problems) expect(problem.message).not.toContain(GOOD);
  });
});
