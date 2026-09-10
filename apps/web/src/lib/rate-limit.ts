/**
 * In-process fixed-window limiter — enough for a single self-hosted instance.
 * Swap for a shared store if the platform is ever scaled horizontally.
 */
export const DEFAULT_LIMIT = 120;
export const WINDOW_MS = 60_000;

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

export function consume(key: string, limit: number = DEFAULT_LIMIT, now: number = Date.now()): RateLimitVerdict {
  const current = windows.get(key);

  if (current === undefined || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: limit - 1, resetInMs: WINDOW_MS };
  }

  current.count += 1;
  const remaining = Math.max(limit - current.count, 0);
  return { allowed: current.count <= limit, remaining, resetInMs: current.resetAt - now };
}

/** Prevents unbounded growth on a long-running process. */
export function sweep(now: number = Date.now()): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}
