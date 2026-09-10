'use server';

import { revalidatePath } from 'next/cache';
import { InfraError } from '@infra/core';
import {
  deleteDatabaseConfig,
  getPrimaryDatabaseConfig,
  recordAudit,
  recordHealth,
  upsertDatabaseConfig,
  type DbProvider,
} from '@infra/db';
import { db } from '@/lib/db';
import { resolver } from '@/lib/resolver';
import { requireAdminSession } from '@/lib/session';

export interface DatabaseActionState {
  ok: boolean;
  message: string;
}

const PROVIDERS: DbProvider[] = ['neon', 'supabase', 'turso'];

export async function saveDatabaseAction(
  _prev: DatabaseActionState,
  formData: FormData,
): Promise<DatabaseActionState> {
  const session = await requireAdminSession();
  const appId = String(formData.get('appId') ?? '');
  const provider = String(formData.get('provider') ?? '') as DbProvider;
  const label = String(formData.get('label') ?? '').trim() || 'primary';
  const connectionString = String(formData.get('connectionString') ?? '').trim();

  if (!PROVIDERS.includes(provider)) return { ok: false, message: 'pick a provider' };
  if (connectionString === '') return { ok: false, message: 'connection string is required' };

  try {
    const row = await upsertDatabaseConfig(db(), { appId, provider, label, connectionString });
    await resolver().invalidate(appId);
    await recordAudit(db(), {
      appId,
      actorType: 'admin',
      actorId: session.userId,
      action: 'db.config.created',
      targetType: 'database_config',
      targetId: row.id,
      // Host only — the credential itself is already encrypted and never logged.
      meta: { provider, host: row.hostHint },
    });

    revalidatePath(`/apps/${appId}/database`);
    return { ok: true, message: `saved and encrypted (${provider})` };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not save that connection' };
  }
}

export async function checkHealthAction(appId: string): Promise<DatabaseActionState> {
  await requireAdminSession();
  try {
    const adapter = await resolver().resolve(appId);
    const report = await adapter.health();
    const config = await getPrimaryDatabaseConfig(db(), appId);
    if (config !== null) await recordHealth(db(), config.id, report.status, report.latencyMs);

    revalidatePath(`/apps/${appId}/database`);
    revalidatePath('/health');
    return { ok: report.status !== 'down', message: `${report.status} (${report.latencyMs ?? '—'} ms)` };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'health check failed' };
  }
}

export async function deleteDatabaseAction(appId: string, configId: string): Promise<void> {
  const session = await requireAdminSession();
  await deleteDatabaseConfig(db(), configId);
  await resolver().invalidate(appId);
  await recordAudit(db(), {
    appId,
    actorType: 'admin',
    actorId: session.userId,
    action: 'db.config.deleted',
    targetType: 'database_config',
    targetId: configId,
  });
  revalidatePath(`/apps/${appId}/database`);
}
