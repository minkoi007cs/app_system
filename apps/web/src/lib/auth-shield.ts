/**
 * Brute-force and weak-password defence in front of Better Auth.
 *
 * This sits between the route handler and `auth().handler`, rather than inside Better Auth, on
 * purpose: it needs nothing from the library's internals, so it keeps working across library
 * upgrades, and every one of its rules can be read in one file.
 *
 * What it enforces, by path:
 *
 *   POST /sign-in/email    throttled per (IP, email) and per IP; every answer padded to the same
 *                          duration so "no such account" and "wrong password" cannot be told apart
 *                          by a stopwatch any more than by a status code.
 *   POST /sign-up/email    new password checked against local rules and the HIBP breach corpus
 *   POST /reset-password   same check — a reset is where someone reaches for a memorable password
 *   POST /change-password  same check
 *
 * Everything else passes straight through.
 *
 * One subtlety worth stating: reading the JSON body consumes the request stream, so the request is
 * rebuilt from the buffered text before it is handed on. Forgetting that is how a shield like this
 * silently turns every sign-in into a 400.
 */
import {
  assessPassword,
  remainingFloorMs,
  sleep,
  type PasswordProblem,
} from '@infra/core';
import {
  checkLoginThrottle,
  clearLoginFailures,
  recordAuditAsync,
  recordLoginFailure,
  type AuditInput,
} from '@infra/db';
import { db } from './db';
import { clientIp, userAgent } from './guard';

type Handler = (request: Request) => Promise<Response>;

interface Credentials {
  email: string | null;
  password: string | null;
  name: string | null;
}

const SIGN_IN_PATHS = ['/sign-in/email'];
const PASSWORD_PATHS = ['/sign-up/email', '/reset-password', '/change-password'];

function matches(pathname: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => pathname.endsWith(suffix));
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Returns the parsed credentials and the body text needed to rebuild the request. */
async function readBody(request: Request): Promise<{ raw: string; credentials: Credentials }> {
  const raw = await request.text();
  const empty: Credentials = { email: null, password: null, name: null };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { raw, credentials: empty };

    const source = parsed as Record<string, unknown>;
    return {
      raw,
      credentials: {
        email: readString(source, 'email'),
        // `newPassword` is what /reset-password and /change-password send.
        password: readString(source, 'password') ?? readString(source, 'newPassword'),
        name: readString(source, 'name'),
      },
    };
  } catch {
    return { raw, credentials: empty };
  }
}

function rebuild(request: Request, body: string): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: 'manual',
  });
}

function problemResponse(problems: readonly PasswordProblem[]): Response {
  return Response.json(
    {
      // Better Auth's own error shape, so the client SDK needs no special case.
      code: 'PASSWORD_REJECTED',
      message: problems[0]?.message ?? 'password rejected',
      problems: problems.map((problem) => problem.code),
    },
    { status: 422 },
  );
}

function lockedResponse(retryAfterMs: number): Response {
  const seconds = Math.max(Math.ceil(retryAfterMs / 1000), 1);
  return Response.json(
    {
      code: 'TOO_MANY_ATTEMPTS',
      message: `too many sign-in attempts — try again in ${seconds}s`,
    },
    { status: 429, headers: { 'retry-after': String(seconds) } },
  );
}

/** Audit writes must never be the reason a sign-in fails. */
function audit(entry: AuditInput): void {
  recordAuditAsync(db(), entry);
}

export async function shieldAuthRequest(request: Request, handler: Handler): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (request.method !== 'POST') return handler(request);
  if (!matches(pathname, SIGN_IN_PATHS) && !matches(pathname, PASSWORD_PATHS)) {
    return handler(request);
  }

  const startedAt = Date.now();
  const { raw, credentials } = await readBody(request);
  const ip = clientIp(request);

  if (matches(pathname, PASSWORD_PATHS) && credentials.password !== null) {
    const identifiers = [credentials.email, credentials.name].filter(
      (value): value is string => value !== null,
    );
    const assessment = await assessPassword(credentials.password, { identifiers });

    if (!assessment.ok) {
      audit({
        actorType: 'system',
        action: 'auth.password.rejected',
        outcome: 'failure',
        ipAddress: ip,
        userAgent: userAgent(request),
        meta: { path: pathname, problems: assessment.problems.map((p) => p.code) },
      });
      return problemResponse(assessment.problems);
    }
  }

  if (!matches(pathname, SIGN_IN_PATHS)) return handler(rebuild(request, raw));

  const identity = { ip, email: credentials.email };
  const verdict = await checkLoginThrottle(db(), identity);

  if (!verdict.allowed) {
    audit({
      actorType: 'system',
      action: 'auth.signin.throttled',
      outcome: 'failure',
      ipAddress: ip,
      userAgent: userAgent(request),
      meta: { retryAfterMs: verdict.retryAfterMs, failureCount: verdict.failureCount },
    });
    // Locked callers are padded too: a fast 429 would still time-separate known from unknown.
    await sleep(remainingFloorMs(Date.now() - startedAt));
    return lockedResponse(verdict.retryAfterMs);
  }

  const response = await handler(rebuild(request, raw));

  if (response.status >= 400) {
    await recordLoginFailure(db(), identity);
    audit({
      actorType: 'system',
      action: 'auth.signin.failed',
      outcome: 'failure',
      ipAddress: ip,
      userAgent: userAgent(request),
      meta: { status: response.status },
    });
  } else {
    await clearLoginFailures(db(), identity);
  }

  await sleep(remainingFloorMs(Date.now() - startedAt));
  return response;
}
