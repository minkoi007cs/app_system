'use server';

import { revalidatePath } from 'next/cache';
import { InfraError } from '@infra/core';
import {
  addMember,
  createApp,
  recordAudit,
  setAppStatus,
  updateAllowedOrigins,
  type AppStatus,
} from '@infra/db';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/admin';

export interface ActionState {
  ok: boolean;
  message: string;
}

function toMessage(error: unknown): string {
  if (InfraError.is(error)) return error.message;
  if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
    return 'that slug is already taken';
  }
  return 'something went wrong — check the server logs';
}

export async function createAppAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSuperAdmin();

  const slug = String(formData.get('slug') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();

  if (name === '' || slug === '') return { ok: false, message: 'name and slug are required' };

  try {
    const app = await createApp(db(), {
      slug,
      name,
      description: description === '' ? null : description,
      ownerUserId: session.userId,
    });
    await addMember(db(), app.id, session.userId, 'owner');
    await recordAudit(db(), {
      appId: app.id,
      actorType: 'admin',
      actorId: session.userId,
      action: 'app.created',
      targetType: 'app',
      targetId: app.id,
      meta: { slug },
    });

    revalidatePath('/apps');
    return { ok: true, message: `created ${app.name}` };
  } catch (error) {
    return { ok: false, message: toMessage(error) };
  }
}

export async function setAppStatusAction(appId: string, status: AppStatus): Promise<void> {
  const session = await requireSuperAdmin();
  await setAppStatus(db(), appId, status);
  await recordAudit(db(), {
    appId,
    actorType: 'admin',
    actorId: session.userId,
    action: status === 'archived' ? 'app.archived' : status === 'suspended' ? 'app.suspended' : 'app.updated',
    targetType: 'app',
    targetId: appId,
  });
  revalidatePath('/apps');
  revalidatePath(`/apps/${appId}`);
}

export async function updateOriginsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSuperAdmin();
  const appId = String(formData.get('appId') ?? '');
  const origins = String(formData.get('origins') ?? '')
    .split(/[\s,]+/)
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  const invalid = origins.filter((origin) => !/^https?:\/\/[^\s/]+$/.test(origin));
  if (invalid.length > 0) {
    return { ok: false, message: `not valid origins: ${invalid.join(', ')}` };
  }

  await updateAllowedOrigins(db(), appId, origins);
  await recordAudit(db(), {
    appId,
    actorType: 'admin',
    actorId: session.userId,
    action: 'app.updated',
    targetType: 'app',
    targetId: appId,
    meta: { originCount: origins.length },
  });

  revalidatePath(`/apps/${appId}`);
  return { ok: true, message: `saved ${origins.length} origin(s)` };
}
