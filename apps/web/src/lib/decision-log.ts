/**
 * Where decision records go.
 *
 * Denials are written immediately, one row each. Allows are counted in memory and flushed as a
 * single summary row per window — see the reasoning in @infra/core's decision-log.ts.
 *
 * The flush is triggered by traffic rather than by a timer: a serverless worker can be frozen
 * between requests, so a `setInterval` either never fires or fires on a process nobody is using.
 * Checking the clock on the way past costs nothing and works in both deployment shapes.
 */
import { DecisionMetrics, flatten, type DecisionSample } from '@infra/core';
import { recordAuditAsync, type AuditInput } from '@infra/db';
import { db } from './db';

export const FLUSH_INTERVAL_MS = 60_000;

interface MetricsGlobal {
  __infraDecisionMetrics?: { metrics: DecisionMetrics; lastFlush: number; appId: string | null };
}

const metricsGlobal = globalThis as unknown as MetricsGlobal;

function state(): { metrics: DecisionMetrics; lastFlush: number; appId: string | null } {
  metricsGlobal.__infraDecisionMetrics ??= {
    metrics: new DecisionMetrics(),
    lastFlush: Date.now(),
    appId: null,
  };
  return metricsGlobal.__infraDecisionMetrics;
}

export interface DecisionContext extends DecisionSample {
  appId: string;
  actorType: AuditInput['actorType'];
  actorId: string;
  /** Populated on a denial: which layer refused, and why. */
  deniedBy?: 'rbac' | 'abac' | null;
  reason?: string;
  matched?: string[];
  ipAddress?: string | null;
}

export function recordDecision(context: DecisionContext): void {
  const current = state();
  current.appId = context.appId;

  if (!context.allowed) {
    // One row, now. A denial is the question somebody will ask later.
    recordAuditAsync(db(), {
      appId: context.appId,
      actorType: context.actorType,
      actorId: context.actorId,
      action: 'access.denied',
      outcome: 'failure',
      targetType: context.resource,
      ipAddress: context.ipAddress ?? null,
      meta: {
        action: context.action,
        deniedBy: context.deniedBy ?? null,
        reason: context.reason ?? 'denied',
        overheadMs: Math.round(context.overheadMs * 100) / 100,
      },
    });
  }

  current.metrics.record(context);
  maybeFlush();
}

/** Flushes when the window has elapsed. Safe to call on every request. */
export function maybeFlush(now: number = Date.now()): void {
  const current = state();
  if (now - current.lastFlush < FLUSH_INTERVAL_MS) return;
  if (current.metrics.size === 0) {
    current.lastFlush = now;
    return;
  }
  flushNow(now);
}

export function flushNow(now: number = Date.now()): void {
  const current = state();
  const summaries = current.metrics.drain();
  const windowMs = now - current.lastFlush;
  current.lastFlush = now;

  if (summaries.length === 0) return;

  recordAuditAsync(db(), {
    appId: current.appId,
    actorType: 'system',
    action: 'access.decision.summary',
    meta: {
      windowMs,
      summaries: summaries.map(flatten),
    },
  });
}
