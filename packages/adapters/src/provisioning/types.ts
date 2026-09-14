/**
 * The provisioning contract: create a database at a provider, hand back a connection string, and
 * be able to destroy exactly what was created.
 *
 * Two rules the implementations all follow, because both are ways to leak:
 *
 *   - **Never leave an orphan.** Provisioning is several API calls (create the project, then fetch
 *     or mint credentials). If a later call fails, the earlier resource is destroyed before the
 *     error is rethrown. A free tier with ten slots fills up fast when failures leave debris.
 *   - **Never log the result.** The returned connection string is a live credential. It travels
 *     from here straight into `upsertDatabaseConfig`, which seals it; nothing in between prints it,
 *     and `hostHint` exists so diagnostics have something safe to show.
 */
import type { DbProvider } from '../types.js';

export interface ProvisionRequest {
  /** App slug — becomes part of the remote resource's name, so it must already be validated. */
  slug: string;
  /** Free-form label shown in the provider's own dashboard. */
  label?: string;
  region?: string;
}

export interface ProvisionedDatabase {
  provider: DbProvider;
  /** The provider's own id — the only handle that can destroy this later. */
  externalId: string;
  /** Live credential. Encrypt immediately; never log, never return to a client. */
  connectionString: string;
  /** Safe to display: host and port, no credentials. */
  hostHint: string | null;
  region: string | null;
}

export interface DatabaseProvisioner {
  readonly provider: DbProvider;
  /** False when the credentials for this provider are absent; the UI greys the option out. */
  isConfigured(): boolean;
  provision(request: ProvisionRequest): Promise<ProvisionedDatabase>;
  /** Must be idempotent: deleting something already gone is a success, not an error. */
  deprovision(externalId: string): Promise<void>;
  /** What the provider says we are using, for the quota display. */
  usage(): Promise<ProviderUsage>;
}

export interface ProviderUsage {
  provider: DbProvider;
  used: number;
  /** Published free-tier ceiling. Null when the provider does not publish one. */
  limit: number | null;
  checkedAt: Date;
}

/** Free-tier ceilings as published; used when the provider's API does not report a limit. */
export const FREE_TIER_LIMITS: Readonly<Record<DbProvider, number | null>> = {
  neon: 10,
  supabase: 2,
  turso: 500,
};
