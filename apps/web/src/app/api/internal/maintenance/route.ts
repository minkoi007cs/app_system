/**
 * POST /api/internal/maintenance — the housekeeping the platform needs someone to call.
 *
 * Every one of these jobs was written alongside the feature it cleans up, and every one of them
 * does nothing until something calls it. That gap is the quiet kind of production failure: the
 * system works perfectly for a month, and then an impersonation session that ran out three weeks
 * ago still reads as active because nothing ever closed it.
 *
 * Each job is run independently and a failure in one does not stop the others — a sweep that
 * cannot run is worth reporting, not worth abandoning the rest of the pass for.
 */
import {
  expireImpersonations,
  purgeSettledDeliveries,
  sweepLoginAttempts,
  sweepRateLimits,
} from '@infra/db';
import { db } from '@/lib/db';
import { assertInternalToken } from '@/lib/internal-auth';
import { flushNow } from '@/lib/decision-log';
import { describeFailures, statusForJobs, type JobResult } from '@/lib/job-report';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Delivered and dropped webhook rows older than this carry no information worth the storage.
 *
 * Deliberately **not** exported. A `route.ts` is not an ordinary module: Next validates its export
 * list against a fixed set of handler names and known config keys, and an extra export is a build
 * error on some versions of that check (`TS2344`, pointing at a generated file in `.next/types`
 * rather than at this line, which is what makes it confusing to diagnose). Next 16.3.4 tolerates
 * it; earlier majors did not. Nothing outside this file reads the constant, so there is no reason
 * to spend the compatibility.
 */
const DELIVERY_RETENTION_DAYS = 14;

async function run(job: string, work: () => Promise<number>): Promise<JobResult> {
  try {
    return { job, ok: true, detail: await work() };
  } catch (error) {
    return { job, ok: false, detail: error instanceof Error ? error.name : 'failed' };
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();

  try {
    assertInternalToken(request);

    const cutoff = new Date(Date.now() - DELIVERY_RETENTION_DAYS * 86_400_000);

    const results = await Promise.all([
      // Counters that have gone quiet carry no information, and the table is keyed by digest so
      // there is nothing to preserve for forensics.
      run('login_attempts', () => sweepLoginAttempts(db())),
      // Closes sessions that ran out, so "still open" always means still open.
      run('impersonations', () => expireImpersonations(db())),
      run('webhook_deliveries', () => purgeSettledDeliveries(db(), cutoff)),
      // Windows that closed carry no information; the table is keyed by digest so there is
      // nothing to keep for forensics either.
      run('rate_limits', () => sweepRateLimits(db())),
    ]);

    // Whatever the aggregation window still holds, written out now rather than waiting for the
    // next request that happens to arrive.
    flushNow();

    // A failed job must reach the HTTP status, not only the body.
    //
    // The caller is cron, and the runbook tells cron to use `curl -fsS` precisely so that a bad
    // response becomes a non-zero exit code. A 200 carrying `{"job":"impersonations","ok":false}`
    // defeats that: curl is happy, cron is silent, and a job that fails every hour forever is
    // invisible. That is what happened — `expireImpersonations` threw on every single run for as
    // long as the endpoint existed, and the only reason anyone found out was calling it by hand
    // and reading the body.
    //
    // The per-job results still come back in full, so a 500 here says *which* job and not merely
    // that something went wrong. The jobs that did succeed have already committed; this status is
    // a report, not a rollback.
    const status = statusForJobs(results);
    const failures = describeFailures(results);
    if (failures !== '') console.error(`[maintenance] ${failures}`);

    return jsonOk({ results, ranAt: new Date().toISOString() }, requestId, { status });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
