/**
 * Password quality: local rules plus a breach lookup.
 *
 * The breach check uses the Have I Been Pwned range API, which is built so the password never
 * leaves the process. We SHA-1 the password, send the first five hex characters of the digest, and
 * the service returns every suffix it holds under that prefix — roughly 800 of them. Matching
 * happens here. The service learns a 5-character prefix shared by hundreds of thousands of
 * passwords and nothing else; that is the whole point of k-anonymity, and it is why SHA-1 being a
 * broken hash is not a problem here — it is an index, not a password store.
 *
 * Failure modes, chosen deliberately and in opposite directions:
 *
 *   Local rules FAIL CLOSED. Too short, or the address in the password: refused, always. These
 *   cost nothing and depend on nothing.
 *
 *   The breach lookup FAILS OPEN. If the API is slow, down, or blocked by egress rules, the
 *   password is accepted. The alternative is that a third party's outage stops every person on the
 *   platform from signing up or recovering an account — an availability bug traded for a marginal
 *   security gain. The assessment records which way it went (`breachCount: null` means unchecked)
 *   so the caller can log it rather than pretend the check happened.
 */
import { createHash } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 12;
/** bcrypt-family hashes silently truncate; refusing long input is clearer than truncating it. */
export const MAX_PASSWORD_LENGTH = 256;
export const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
export const HIBP_TIMEOUT_MS = 2_000;
/** Below this the password is common enough to refuse outright. 1 is already too many. */
export const BREACH_THRESHOLD = 1;

export type PasswordProblemCode =
  | 'too_short'
  | 'too_long'
  | 'too_simple'
  | 'contains_identifier'
  | 'breached';

export interface PasswordProblem {
  code: PasswordProblemCode;
  /** Safe to show a person: says what to fix, never what was tried. */
  message: string;
}

export interface PasswordAssessment {
  ok: boolean;
  problems: PasswordProblem[];
  /** Times seen in a breach corpus; null when the lookup did not complete. */
  breachCount: number | null;
  breachCheckPerformed: boolean;
}

// ── k-anonymity ──────────────────────────────────────────────────────────────

export interface HibpRange {
  /** Sent to the API. */
  prefix: string;
  /** Kept here. */
  suffix: string;
}

export function hibpRange(password: string): HibpRange {
  const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  return { prefix: digest.slice(0, 5), suffix: digest.slice(5) };
}

/**
 * Parses a range response into a count for one suffix.
 *
 * Handles two details that bite: responses are CRLF-delimited, and with `Add-Padding` the service
 * mixes in decoy entries whose count is 0 — a decoy must read as "not found", not as "found zero
 * times", because those two would otherwise be distinguishable.
 */
export function countBreachesInRange(body: string, suffix: string): number {
  const wanted = suffix.trim().toUpperCase();

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;

    if (trimmed.slice(0, separator).toUpperCase() !== wanted) continue;

    const count = Number.parseInt(trimmed.slice(separator + 1), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  return 0;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BreachLookupOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  rangeUrl?: string;
}

/** Returns null — never throws — when the service could not be reached. See the header comment. */
export async function lookupBreachCount(
  password: string,
  options: BreachLookupOptions = {},
): Promise<number | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  const { prefix, suffix } = hibpRange(password);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? HIBP_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${options.rangeUrl ?? HIBP_RANGE_URL}${prefix}`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        // Pads the response to a uniform size so its length cannot hint at the prefix.
        'Add-Padding': 'true',
        'User-Agent': 'unified-app-infra',
      },
    });

    if (!response.ok) return null;
    return countBreachesInRange(await response.text(), suffix);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── local rules ──────────────────────────────────────────────────────────────

/**
 * Not a dictionary — HIBP is the dictionary. This catches only the shapes a corpus lookup would
 * also catch but that we should not need a network round trip to refuse.
 */
const TRIVIAL_PATTERNS: readonly RegExp[] = [
  /^(.)\1+$/, // aaaaaaaaaaaa
  /^(?:0123456789|1234567890|abcdefghij)/i,
  /^(?:password|passw0rd|qwerty|letmein|welcome|iloveyou|admin|changeme)/i,
];

/**
 * Everything the account already publishes, reduced to comparable form.
 *
 * Comparing raw strings is close to useless here: "Khoi-Hoang-2026!" does not literally contain
 * "khoi.hoang@example.com", or even "Khoi Hoang", yet it is exactly the password this rule exists
 * to refuse. So both sides are stripped down to letters and digits before comparing, and each word
 * of an identifier is a candidate on its own.
 */
function normaliseForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const MIN_IDENTIFIER_LENGTH = 4;

export function identifierCandidates(identifiers: readonly string[]): string[] {
  const candidates = new Set<string>();

  for (const identifier of identifiers) {
    const localPart = identifier.split('@')[0] ?? identifier;

    for (const piece of [identifier, localPart, ...localPart.split(/[^A-Za-z0-9]+/)]) {
      const normalised = normaliseForComparison(piece);
      if (normalised.length >= MIN_IDENTIFIER_LENGTH) candidates.add(normalised);
    }
  }

  return [...candidates];
}

export function assessPasswordLocally(
  password: string,
  identifiers: readonly string[] = [],
): PasswordProblem[] {
  const problems: PasswordProblem[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push({
      code: 'too_short',
      message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    });
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    problems.push({
      code: 'too_long',
      message: `password must be at most ${MAX_PASSWORD_LENGTH} characters`,
    });
  }

  if (TRIVIAL_PATTERNS.some((pattern) => pattern.test(password))) {
    problems.push({ code: 'too_simple', message: 'that password is a well-known pattern' });
  }

  const reduced = normaliseForComparison(password);
  if (identifierCandidates(identifiers).some((candidate) => reduced.includes(candidate))) {
    problems.push({
      code: 'contains_identifier',
      message: 'password must not contain your email address or name',
    });
  }

  return problems;
}

export interface AssessPasswordOptions extends BreachLookupOptions {
  identifiers?: readonly string[];
  /** Set false to skip the network entirely (tests, air-gapped deploys). */
  checkBreaches?: boolean;
  threshold?: number;
}

export async function assessPassword(
  password: string,
  options: AssessPasswordOptions = {},
): Promise<PasswordAssessment> {
  const problems = assessPasswordLocally(password, options.identifiers ?? []);

  // A password that already fails a local rule is refused; no reason to spend a round trip on it.
  if (problems.length > 0 || options.checkBreaches === false) {
    return { ok: problems.length === 0, problems, breachCount: null, breachCheckPerformed: false };
  }

  const breachCount = await lookupBreachCount(password, options);
  if (breachCount === null) {
    return { ok: true, problems, breachCount: null, breachCheckPerformed: false };
  }

  if (breachCount >= (options.threshold ?? BREACH_THRESHOLD)) {
    problems.push({
      code: 'breached',
      message: 'that password appears in a known data breach — please choose a different one',
    });
  }

  return { ok: problems.length === 0, problems, breachCount, breachCheckPerformed: true };
}
