/**
 * Two layers, and only one of them is the authority.
 *
 * The old implementation counted in process memory. That was correct for exactly one deployment
 * shape — a single self-hosted instance — and on serverless it silently multiplies every limit by
 * the number of instances. Nothing errors; the ceiling is just quietly higher than the number in
 * the config, which is the worst kind of security bug: one that looks like it is working.
 *
 * So the shared counter in the Master DB is now the authority. The in-process counter is kept, but
 * demoted to something it cannot get wrong:
 *
 *   **The local layer may only refuse, never allow.** If this instance alone has already seen more
 *   than the limit in this window, the caller is over it globally too — that is arithmetic, not a
 *   guess — so it can be refused without a round trip. Anything the local layer would permit still
 *   goes to the shared counter for the real answer.
 *
 * That ordering matters because the traffic that makes rate limiting expensive is abusive traffic,
 * and abusive traffic is exactly what the local layer can turn away for free.
 *
 * Both layers fail **open**: an abuse ceiling is a guard rail, not an authorisation check. Every
 * check that decides who may see what fails closed, elsewhere.
 */
import { consumeShared, DEFAULT_LIMIT, WINDOW_MS, type RateLimitVerdict } from '@infra/db';
import { db } from './db';

export { DEFAULT_LIMIT, WINDOW_MS };
export type { RateLimitVerdict };

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
/** Bounded so a caller generating fresh identities cannot grow this map without limit. */
const MAX_LOCAL_KEYS = 10_000;

/**
 * Local pre-check. Returns a verdict only when it can refuse; null means "ask the shared store".
 *
 * Exported for testing, because the invariant worth asserting is negative: this function must
 * never return an `allowed: true` verdict. A local layer that could allow would be a local layer
 * that could raise the global ceiling.
 */
export function localRefusal(key: string, limit: number, now: number): RateLimitVerdict | null {
  const current = windows.get(key);

  if (current === undefined || current.resetAt <= now) {
    if (windows.size >= MAX_LOCAL_KEYS) windows.clear();
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }

  current.count += 1;
  if (current.count <= limit) return null;

  return { allowed: false, remaining: 0, resetInMs: current.resetAt - now };
}

export async function consume(
  identity: string,
  limit: number = DEFAULT_LIMIT,
  now: number = Date.now(),
): Promise<RateLimitVerdict> {
  const refusal = localRefusal(identity, limit, now);
  if (refusal !== null) return refusal;

  try {
    return await consumeShared(db(), identity, limit, WINDOW_MS, new Date(now));
  } catch {
    // The database is the authority, but it is not allowed to be a single point of failure for
    // the whole API. A counter that cannot be written must not take requests down with it.
    return { allowed: true, remaining: limit, resetInMs: WINDOW_MS };
  }
}

/** Prevents unbounded growth of the local layer on a long-running process. */
export function sweep(now: number = Date.now()): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}
