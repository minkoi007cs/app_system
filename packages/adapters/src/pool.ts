/**
 * Bounded adapter cache: LRU by last use, with a TTL so a rotated credential cannot
 * stay live forever. Only initialised adapters are cached — never a plaintext DSN.
 */
import type { DatabaseAdapter } from './types.js';

export const DEFAULT_POOL_SIZE = 25;
export const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface AdapterPoolOptions {
  max?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface PoolStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
}

interface PoolEntry {
  adapter: DatabaseAdapter;
  createdAt: number;
  lastUsedAt: number;
}

export interface AdapterPool {
  get(key: string): DatabaseAdapter | null;
  set(key: string, adapter: DatabaseAdapter): Promise<void>;
  invalidate(key: string): Promise<void>;
  clear(): Promise<void>;
  has(key: string): boolean;
  stats(): PoolStats;
}

export function createAdapterPool(options: AdapterPoolOptions = {}): AdapterPool {
  const max = options.max ?? DEFAULT_POOL_SIZE;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());

  const entries = new Map<string, PoolEntry>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let expirations = 0;

  function discard(key: string, entry: PoolEntry): void {
    entries.delete(key);
    void entry.adapter.close().catch(() => {
      /* closing a dead connection must never bubble up */
    });
  }

  function evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestUsedAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of entries) {
      if (entry.lastUsedAt < oldestUsedAt) {
        oldestUsedAt = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return;
    const victim = entries.get(oldestKey);
    if (victim === undefined) return;
    evictions += 1;
    discard(oldestKey, victim);
  }

  return {
    get(key: string): DatabaseAdapter | null {
      const entry = entries.get(key);
      if (entry === undefined) {
        misses += 1;
        return null;
      }
      if (now() - entry.createdAt >= ttlMs) {
        expirations += 1;
        misses += 1;
        discard(key, entry);
        return null;
      }
      entry.lastUsedAt = now();
      hits += 1;
      return entry.adapter;
    },

    async set(key: string, adapter: DatabaseAdapter): Promise<void> {
      const existing = entries.get(key);
      if (existing !== undefined) discard(key, existing);
      while (entries.size >= max) evictOldest();
      const timestamp = now();
      entries.set(key, { adapter, createdAt: timestamp, lastUsedAt: timestamp });
    },

    async invalidate(key: string): Promise<void> {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entries.delete(key);
      await entry.adapter.close().catch(() => {});
    },

    async clear(): Promise<void> {
      const current = [...entries.entries()];
      entries.clear();
      await Promise.all(current.map(([, entry]) => entry.adapter.close().catch(() => {})));
    },

    has(key: string): boolean {
      return entries.has(key);
    },

    stats(): PoolStats {
      return { size: entries.size, hits, misses, evictions, expirations };
    },
  };
}
