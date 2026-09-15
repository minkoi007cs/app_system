/**
 * Turning a set of job results into an HTTP status.
 *
 * Three lines, in their own file, with their own test — because the bug this replaces was not a
 * hard one. `/api/internal/maintenance` ran four jobs, put `ok: false` in the body when one threw,
 * and returned 200 anyway. Cron calls it with `curl -fsS` specifically so a bad response becomes a
 * non-zero exit code, and a 200 makes that check meaningless. `expireImpersonations` failed on
 * every run for as long as the endpoint existed and nothing ever said so.
 *
 * The invariant is one sentence — **any failed job must produce a non-2xx status** — and it is
 * exactly the kind that is easy to lose in a refactor and impossible to notice in production.
 */
export interface JobResult {
  job: string;
  ok: boolean;
  detail: number | string;
}

export function statusForJobs(results: readonly JobResult[]): number {
  return results.every((result) => result.ok) ? 200 : 500;
}

/** One line naming the jobs that failed, for the log. Never includes the caller's token. */
export function describeFailures(results: readonly JobResult[]): string {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return '';
  return (
    `${failed.length}/${results.length} jobs failed: ` +
    failed.map((result) => `${result.job}=${String(result.detail)}`).join(' ')
  );
}
