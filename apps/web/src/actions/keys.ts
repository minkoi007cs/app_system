'use server';

import { revalidatePath } from 'next/cache';
import type { ApiKeyKind, ApiKeyScope } from '@infra/core';
import { issueApiKey, recordAudit, revokeApiKey, rotateApiKey } from '@infra/db';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/admin';

export interface IssueKeyState {
  ok: boolean;
  message: string;
  /** Returned exactly once, straight after creation. Never stored anywhere. */
  rawKey?: string;
}

const ALL_SCOPES: ApiKeyScope[] = ['db:read', 'db:write', 'auth:read', 'admin'];

export async function issueKeyAction(_prev: IssueKeyState, formData: FormData): Promise<IssueKeyState> {
  const session = await requireSuperAdmin();
  const appId = String(formData.get('appId') ?? '');
  const name = String(formData.get('name') ?? '').trim() || 'untitled key';
  const environment = formData.get('environment') === 'test' ? 'test' : 'live';
  const kind: ApiKeyKind = formData.get('kind') === 'publishable' ? 'publishable' : 'secret';
  const scopes = ALL_SCOPES.filter((scope) => formData.get(scope) === 'on');

  const issued = await issueApiKey(db(), {
    appId,
    name,
    createdBy: session.userId,
    environment,
    kind,
    scopes: scopes.length > 0 ? scopes : ['db:read'],
  });

  await recordAudit(db(), {
    appId,
    actorType: 'admin',
    actorId: session.userId,
    action: 'key.issued',
    targetType: 'api_key',
    targetId: issued.row.id,
    meta: { prefix: issued.row.keyPrefix, scopes: issued.row.scopes },
  });

  revalidatePath(`/apps/${appId}/keys`);
  const warning =
    kind === 'secret'
      ? 'copy this key now — it will never be shown again. Server-side only: never ship it to a browser.'
      : 'copy this key now — it will never be shown again. Safe to embed in a browser bundle.';
  return { ok: true, message: warning, rawKey: issued.rawKey };
}

export async function revokeKeyAction(appId: string, keyId: string): Promise<void> {
  const session = await requireSuperAdmin();
  await revokeApiKey(db(), keyId);
  await recordAudit(db(), {
    appId,
    actorType: 'admin',
    actorId: session.userId,
    action: 'key.revoked',
    targetType: 'api_key',
    targetId: keyId,
  });
  revalidatePath(`/apps/${appId}/keys`);
}

export async function rotateKeyAction(appId: string, keyId: string): Promise<IssueKeyState> {
  const session = await requireSuperAdmin();
  const issued = await rotateApiKey(db(), keyId, session.userId);
  await recordAudit(db(), {
    appId,
    actorType: 'admin',
    actorId: session.userId,
    action: 'key.rotated',
    targetType: 'api_key',
    targetId: issued.row.id,
  });
  revalidatePath(`/apps/${appId}/keys`);
  return { ok: true, message: 'rotated — copy the new key now', rawKey: issued.rawKey };
}
