/**
 * Provision a database for an app, and reclaim it afterwards.
 *
 * This is the orchestration the two provisioners deliberately do not contain: quota check, remote
 * create, bookkeeping row, encrypted config, audit. It lives in the app rather than in a package
 * because it is the only step that touches all four.
 *
 * The order is the whole point:
 *
 *   create at provider → record what was created → seal the DSN into a config
 *
 * If the middle step fails we delete the remote resource before reporting, because an unrecorded
 * resource is unreachable forever. If the last step fails we keep the record and roll the remote
 * resource back — a record with no config is visible to the reclaim pass, which is recoverable.
 */
import { collectUsage, createProvisioner, type ProvisionedDatabase } from '@infra/adapters';
import { InfraError } from '@infra/core';
import {
  collectUsageInto,
  markReleased,
  markReleaseFailed,
  markReleasing,
  quotaFor,
  recordAuditAsync,
  recordProvisionedResource,
  listProvisionedResources,
  upsertDatabaseConfig,
  type DbProvider,
  type InfraDatabaseConfigRow,
} from '@infra/db';
import { db } from './db';

export interface ProvisionForAppInput {
  appId: string;
  slug: string;
  provider: DbProvider;
  actorId: string;
  region?: string;
}

export interface ProvisionOutcome {
  config: InfraDatabaseConfigRow;
  provider: DbProvider;
  externalId: string;
}

export async function provisionForApp(input: ProvisionForAppInput): Promise<ProvisionOutcome> {
  const provisioner = createProvisioner(input.provider);

  if (!provisioner.isConfigured()) {
    throw new InfraError('CONFIG_INVALID', `${input.provider} provisioning is not configured`, {
      details: { provider: input.provider },
    });
  }

  const quota = await quotaFor(db(), input.provider);
  if (!quota.allowed) {
    throw new InfraError('VALIDATION_FAILED', quota.reason ?? 'provider quota exhausted', {
      details: { provider: input.provider, used: quota.used, limit: quota.limit },
    });
  }

  let created: ProvisionedDatabase;
  try {
    created = await provisioner.provision({
      slug: input.slug,
      ...(input.region === undefined ? {} : { region: input.region }),
    });
  } catch (error) {
    recordAuditAsync(db(), {
      appId: input.appId,
      actorType: 'admin',
      actorId: input.actorId,
      action: 'db.provision.failed',
      outcome: 'failure',
      meta: { provider: input.provider, code: InfraError.is(error) ? error.code : 'INTERNAL' },
    });
    throw error;
  }

  let resourceId: string;
  try {
    const resource = await recordProvisionedResource(db(), {
      appId: input.appId,
      provider: input.provider,
      externalId: created.externalId,
      region: created.region,
    });
    resourceId = resource.id;
  } catch (error) {
    // Nothing points at the remote resource yet, so it must go now or it is lost.
    await provisioner.deprovision(created.externalId).catch(() => {});
    throw error;
  }

  try {
    const config = await upsertDatabaseConfig(db(), {
      appId: input.appId,
      provider: input.provider,
      label: `${input.provider}:${input.slug}`,
      // The only place the plaintext DSN is passed anywhere; upsert seals it before it is stored.
      connectionString: created.connectionString,
      isPrimary: true,
    });

    recordAuditAsync(db(), {
      appId: input.appId,
      actorType: 'admin',
      actorId: input.actorId,
      action: 'db.provisioned',
      targetType: 'database_config',
      targetId: config.id,
      // externalId and hostHint only — never the connection string.
      meta: { provider: input.provider, externalId: created.externalId, hostHint: created.hostHint },
    });

    return { config, provider: input.provider, externalId: created.externalId };
  } catch (error) {
    await releaseResourceById(resourceId, input.provider, created.externalId);
    throw error;
  }
}

async function releaseResourceById(
  resourceId: string,
  provider: DbProvider,
  externalId: string,
): Promise<void> {
  await markReleasing(db(), resourceId);
  try {
    await createProvisioner(provider).deprovision(externalId);
    await markReleased(db(), resourceId);
  } catch {
    /* left for the reclaim pass; markReleaseFailed needs the row, handled there */
  }
}

export interface ReleaseResult {
  released: number;
  failed: number;
}

/** Called when an app is deleted: destroy everything the platform created on its behalf. */
export async function releaseAppResources(appId: string): Promise<ReleaseResult> {
  const resources = await listProvisionedResources(db(), appId);
  let released = 0;
  let failed = 0;

  for (const resource of resources) {
    if (resource.state === 'released') continue;

    await markReleasing(db(), resource.id);
    try {
      await createProvisioner(resource.provider).deprovision(resource.externalId);
      await markReleased(db(), resource.id);
      released += 1;
    } catch (error) {
      await markReleaseFailed(
        db(),
        resource,
        InfraError.is(error) ? error.code : 'release failed',
      );
      failed += 1;
    }
  }

  return { released, failed };
}

/** Refreshes every configured provider's usage reading. Safe to run on a schedule. */
export async function refreshQuotas(): Promise<number> {
  const readings = await collectUsage();
  return collectUsageInto(
    db(),
    readings.map((reading) => ({
      provider: reading.provider,
      used: reading.used,
      limit: reading.limit,
      error: reading.used < 0 ? 'usage poll failed' : null,
    })),
  );
}
