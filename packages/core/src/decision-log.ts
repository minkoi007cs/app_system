/**
 * What the rules engine decided, and what it cost.
 *
 * The obvious implementation — one audit row per authorisation decision — is the wrong one here.
 * A dashboard that polls a list every few seconds produces thousands of identical "allowed" rows a
 * day, and on a 0.5 GB free-tier Master DB the log of what happened would outgrow the data it
 * describes within a week. Deleting old rows then becomes load-bearing, and the first time that
 * job fails the platform stops accepting writes.
 *
 * So the two halves are treated differently, because they are used differently:
 *
 *   **Denials are written individually.** They are rare, and each one is a question somebody will
 *   eventually ask — why could this user not see that row? A denial with no record is a support
 *   ticket with no answer.
 *
 *   **Allows are aggregated in memory** into counts and a latency histogram per
 *   (resource, action), and flushed as one row per window. That answers "is the rules engine
 *   slow?" and "which tables are hot?" without keeping a row per read.
 *
 * The accumulator is deliberately pure and bounded: no timers, no I/O, and a hard cap on distinct
 * keys so a caller looping over generated resource names cannot grow it without limit.
 */

/** Bucket upper bounds in milliseconds. Logarithmic, so p95 stays meaningful across three orders. */
export const LATENCY_BUCKETS_MS: readonly number[] = [
  0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500,
];

export const MAX_TRACKED_KEYS = 200;

export interface LatencyHistogram {
  /** One counter per bucket, plus a final overflow counter. */
  buckets: number[];
  count: number;
  sumMs: number;
  maxMs: number;
}

export function emptyHistogram(): LatencyHistogram {
  return { buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), count: 0, sumMs: 0, maxMs: 0 };
}

export function observe(histogram: LatencyHistogram, ms: number): void {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
  let index = LATENCY_BUCKETS_MS.findIndex((bound) => value <= bound);
  if (index === -1) index = LATENCY_BUCKETS_MS.length;

  const bucket = histogram.buckets[index];
  histogram.buckets[index] = (bucket ?? 0) + 1;
  histogram.count += 1;
  histogram.sumMs += value;
  if (value > histogram.maxMs) histogram.maxMs = value;
}

/**
 * Approximate percentile from the bucket counts.
 *
 * Returns the bucket's upper bound, so the answer is an over-estimate rather than an under-estimate
 * — the direction you want when the number is being compared against a latency budget.
 */
export function percentile(histogram: LatencyHistogram, fraction: number): number {
  if (histogram.count === 0) return 0;

  const target = Math.ceil(histogram.count * fraction);
  let seen = 0;

  for (const [index, count] of histogram.buckets.entries()) {
    seen += count ?? 0;
    if (seen >= target) return LATENCY_BUCKETS_MS[index] ?? histogram.maxMs;
  }
  return histogram.maxMs;
}

export function meanMs(histogram: LatencyHistogram): number {
  return histogram.count === 0 ? 0 : histogram.sumMs / histogram.count;
}

export interface DecisionSummary {
  resource: string;
  action: string;
  allowed: number;
  denied: number;
  /** Time spent in the rules engine — RBAC lookup, policy fetch, decision, compile. */
  overhead: LatencyHistogram;
  /** Total request time, so the overhead can be read as a share of it. */
  total: LatencyHistogram;
}

export interface DecisionSample {
  resource: string;
  action: string;
  allowed: boolean;
  overheadMs: number;
  totalMs: number;
}

/**
 * In-process aggregation between flushes. One per worker; nothing here is shared or persisted, and
 * losing a window to a restart costs a few counters, not correctness.
 */
export class DecisionMetrics {
  private readonly summaries = new Map<string, DecisionSummary>();
  private dropped = 0;

  record(sample: DecisionSample): void {
    const key = `${sample.resource}:${sample.action}`;
    let summary = this.summaries.get(key);

    if (summary === undefined) {
      if (this.summaries.size >= MAX_TRACKED_KEYS) {
        // Bounded on purpose: a caller iterating over invented resource names must not be able to
        // grow this map. The drop is counted so the gap is visible rather than silent.
        this.dropped += 1;
        return;
      }
      summary = {
        resource: sample.resource,
        action: sample.action,
        allowed: 0,
        denied: 0,
        overhead: emptyHistogram(),
        total: emptyHistogram(),
      };
      this.summaries.set(key, summary);
    }

    if (sample.allowed) summary.allowed += 1;
    else summary.denied += 1;

    observe(summary.overhead, sample.overheadMs);
    observe(summary.total, sample.totalMs);
  }

  get size(): number {
    return this.summaries.size;
  }

  get droppedKeys(): number {
    return this.dropped;
  }

  /** Returns the window's summaries and resets, so a flush cannot double-count. */
  drain(): DecisionSummary[] {
    const snapshot = [...this.summaries.values()];
    this.summaries.clear();
    this.dropped = 0;
    return snapshot;
  }
}

export interface FlatDecisionSummary {
  resource: string;
  action: string;
  allowed: number;
  denied: number;
  overheadP50Ms: number;
  overheadP95Ms: number;
  overheadMaxMs: number;
  overheadMeanMs: number;
  totalP95Ms: number;
}

/** The shape that goes into an audit row's meta: small, flat and free of per-request detail. */
export function flatten(summary: DecisionSummary): FlatDecisionSummary {
  return {
    resource: summary.resource,
    action: summary.action,
    allowed: summary.allowed,
    denied: summary.denied,
    overheadP50Ms: percentile(summary.overhead, 0.5),
    overheadP95Ms: percentile(summary.overhead, 0.95),
    overheadMaxMs: Math.round(summary.overhead.maxMs * 100) / 100,
    overheadMeanMs: Math.round(meanMs(summary.overhead) * 100) / 100,
    totalP95Ms: percentile(summary.total, 0.95),
  };
}
