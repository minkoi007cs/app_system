import { describe, expect, it } from 'vitest';
import {
  DecisionMetrics,
  emptyHistogram,
  flatten,
  LATENCY_BUCKETS_MS,
  MAX_TRACKED_KEYS,
  meanMs,
  observe,
  percentile,
} from '../src/decision-log.js';

describe('histogram', () => {
  it('starts empty and reports zero rather than NaN', () => {
    const histogram = emptyHistogram();
    expect(histogram.count).toBe(0);
    expect(percentile(histogram, 0.95)).toBe(0);
    expect(meanMs(histogram)).toBe(0);
  });

  it('counts one sample per observation and tracks the max', () => {
    const histogram = emptyHistogram();
    observe(histogram, 1);
    observe(histogram, 40);
    observe(histogram, 3);
    expect(histogram.count).toBe(3);
    expect(histogram.maxMs).toBe(40);
    expect(meanMs(histogram)).toBeCloseTo(44 / 3, 5);
  });

  it('puts a sample in the first bucket whose bound it does not exceed', () => {
    const histogram = emptyHistogram();
    observe(histogram, 0.4);
    observe(histogram, 0.5);
    expect(histogram.buckets[0]).toBe(2);
  });

  it('puts anything past the last bound into the overflow bucket', () => {
    const histogram = emptyHistogram();
    observe(histogram, 99_999);
    expect(histogram.buckets[LATENCY_BUCKETS_MS.length]).toBe(1);
    expect(histogram.maxMs).toBe(99_999);
  });

  it('over-estimates a percentile rather than under-estimating it', () => {
    // The number gets compared against a latency budget, so erring high is the safe direction.
    const histogram = emptyHistogram();
    for (let i = 0; i < 99; i += 1) observe(histogram, 1);
    observe(histogram, 900);

    expect(percentile(histogram, 0.5)).toBe(1);
    expect(percentile(histogram, 0.95)).toBe(1);
    // The single slow sample lands in the 1000ms bucket, and p99.9 must reach it.
    expect(percentile(histogram, 1)).toBe(1_000);
  });

  it('treats a negative or non-finite duration as zero instead of corrupting the buckets', () => {
    const histogram = emptyHistogram();
    observe(histogram, -5);
    observe(histogram, Number.NaN);
    expect(histogram.count).toBe(2);
    expect(histogram.maxMs).toBe(0);
  });
});

describe('DecisionMetrics', () => {
  const sample = (over: Partial<Parameters<DecisionMetrics['record']>[0]> = {}) => ({
    resource: 'notes',
    action: 'select',
    allowed: true,
    overheadMs: 2,
    totalMs: 20,
    ...over,
  });

  it('groups by resource and action', () => {
    const metrics = new DecisionMetrics();
    metrics.record(sample());
    metrics.record(sample());
    metrics.record(sample({ action: 'insert' }));
    metrics.record(sample({ resource: 'tasks' }));

    const drained = metrics.drain();
    expect(drained).toHaveLength(3);
    expect(drained.find((s) => s.action === 'select' && s.resource === 'notes')?.allowed).toBe(2);
  });

  it('counts allows and denials separately', () => {
    const metrics = new DecisionMetrics();
    metrics.record(sample());
    metrics.record(sample({ allowed: false }));
    metrics.record(sample({ allowed: false }));

    const [summary] = metrics.drain();
    expect(summary?.allowed).toBe(1);
    expect(summary?.denied).toBe(2);
  });

  it('resets on drain, so a flush cannot double-count a window', () => {
    const metrics = new DecisionMetrics();
    metrics.record(sample());
    expect(metrics.drain()).toHaveLength(1);
    expect(metrics.drain()).toHaveLength(0);
    expect(metrics.size).toBe(0);
  });

  it('is bounded — a caller inventing resource names cannot grow it without limit', () => {
    const metrics = new DecisionMetrics();
    for (let i = 0; i < MAX_TRACKED_KEYS + 50; i += 1) {
      metrics.record(sample({ resource: `generated_${i}` }));
    }
    expect(metrics.size).toBe(MAX_TRACKED_KEYS);
    expect(metrics.droppedKeys).toBe(50);
  });

  it('keeps the rules overhead separate from the total request time', () => {
    const metrics = new DecisionMetrics();
    metrics.record(sample({ overheadMs: 3, totalMs: 250 }));

    const [summary] = metrics.drain();
    expect(summary?.overhead.maxMs).toBe(3);
    expect(summary?.total.maxMs).toBe(250);
  });
});

describe('flatten', () => {
  it('produces a small flat object with no per-request detail in it', () => {
    const metrics = new DecisionMetrics();
    for (let i = 0; i < 20; i += 1) {
      metrics.record({ resource: 'notes', action: 'select', allowed: true, overheadMs: 2, totalMs: 30 });
    }

    const [summary] = metrics.drain();
    const flat = flatten(summary!);

    expect(flat).toMatchObject({ resource: 'notes', action: 'select', allowed: 20, denied: 0 });
    expect(flat.overheadP95Ms).toBeLessThanOrEqual(5);
    expect(flat.overheadMeanMs).toBe(2);
    expect(Object.keys(flat)).toHaveLength(9);
  });

  it('rounds the mean and max so a summary row stays compact', () => {
    const metrics = new DecisionMetrics();
    metrics.record({
      resource: 'notes',
      action: 'select',
      allowed: true,
      overheadMs: 1.23456789,
      totalMs: 9.87654321,
    });

    const flat = flatten(metrics.drain()[0]!);
    expect(flat.overheadMaxMs).toBe(1.23);
    expect(flat.overheadMeanMs).toBe(1.23);
  });
});
