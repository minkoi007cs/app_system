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
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Delivered and dropped webhook rows older than this carry no information worth the storage. */
export const DELIVERY_RETENTION_DAYS = 14;

interface JobResult {
  job: string;
  ok: boolean;
  detail: number | string;
}

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

    return jsonOk({ results, ranAt: new Date().toISOString() }, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
