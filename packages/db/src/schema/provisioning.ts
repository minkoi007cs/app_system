/**
 * What the platform created at a provider, and what it is allowed to create.
 *
 * `infra_provisioned_resources` exists because of one failure mode: a row in `infra_apps` is deleted,
 * and the Neon project it owned keeps existing, invisible, holding one of ten free slots forever.
 * The external id is recorded at creation time and survives the app row (`on delete set null`) until
 * a reclaim pass has actually destroyed the remote resource.
 */
import { index, integer, pgTable, timestamp, uuid, varchar, text } from 'drizzle-orm/pg-core';
import { infraApps } from './apps.js';
import type { DbProvider } from './database-configs.js';

export const PROVISION_STATES = ['active', 'releasing', 'released', 'orphaned'] as const;
export type ProvisionState = (typeof PROVISION_STATES)[number];

export const infraProvisionedResources = pgTable(
  'infra_provisioned_resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null once the app is gone but the remote resource has not been reclaimed yet. */
    appId: uuid('app_id').references(() => infraApps.id, { onDelete: 'set null' }),
    provider: varchar('provider', { length: 16 }).notNull().$type<DbProvider>(),
    /** The provider's own id — the only handle that can delete this. */
    externalId: varchar('external_id', { length: 255 }).notNull(),
    region: varchar('region', { length: 64 }),
    state: varchar('state', { length: 16 }).notNull().default('active').$type<ProvisionState>(),
    /** Kept so an operator can see what was attempted; never holds a credential. */
    lastError: varchar('last_error', { length: 255 }),
    releaseAttempts: integer('release_attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [
    index('infra_provisioned_app_idx').on(t.appId),
    index('infra_provisioned_state_idx').on(t.state, t.provider),
  ],
);

export const infraProviderQuotas = pgTable('infra_provider_quotas', {
  provider: varchar('provider', { length: 16 }).primaryKey().$type<DbProvider>(),
  used: integer('used').notNull().default(0),
  /** Null means the provider publishes no ceiling we can check against. */
  quotaLimit: integer('quota_limit'),
  /** Set when a usage read failed, so the dashboard can say "stale" rather than show a wrong 0. */
  lastError: text('last_error'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
});

export type InfraProvisionedResourceRow = typeof infraProvisionedResources.$inferSelect;
export type InfraProviderQuotaRow = typeof infraProviderQuotas.$inferSelect;
