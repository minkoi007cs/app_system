'use server';

import { revalidatePath } from 'next/cache';
import { InfraError, ipAllowed, type ApiKeyScope } from '@infra/core';
import {
  createServiceAccount,
  createWorkspace,
  issueServiceAccountKey,
  recordAudit,
  revokeServiceAccount,
} from '@infra/db';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/admin';

export interface MachineState {
  ok: boolean;
  message: string;
  /** Shown exactly once, straight after creation. */
  rawKey?: string;
}

const SCOPES: ApiKeyScope[] = ['db:read', 'db:write', 'auth:read', 'admin'];

export async function createServiceAccountAction(
  _prev: MachineState,
  formData: FormData,
): Promise<MachineState> {
  try {
    const admin = await requireSuperAdmin();
    const appId = String(formData.get('appId') ?? '');
    const name = String(formData.get('name') ?? '').trim();
    const description = String(formData.get('description') ?? '').trim();
    const ownerUserId = String(formData.get('ownerUserId') ?? '').trim() || admin.userId;
    const scopes = SCOPES.filter((scope) => formData.get(scope) === 'on');

    const ipAllowlist = String(formData.get('ipAllowlist') ?? '')
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');

    if (name === '') throw new InfraError('VALIDATION_FAILED', 'give the account a name');

    // Each entry is checked by matching it against itself: a malformed CIDR matches nothing, which
    // would silently lock the account out of everywhere rather than restrict it to somewhere.
    for (const entry of ipAllowlist) {
      const sample = entry.split('/')[0] ?? entry;
      if (!ipAllowed(sample, [entry])) {
        throw new InfraError('VALIDATION_FAILED', `"${entry}" is not a valid address or CIDR range`);
      }
    }

    const account = await createServiceAccount(db(), {
      appId,
      name,
      ...(description === '' ? {} : { description }),
      // Required, not optional: a credential nobody answers for is the one still working two years
      // after its author left.
      ownerUserId,
      scopes: scopes.length > 0 ? scopes : ['db:read'],
      ipAllowlist,
    });

    await recordAudit(db(), {
      appId,
      actorType: 'admin',
      actorId: admin.userId,
      action: 'service_account.created',
      targetType: 'service_account',
      targetId: account.id,
      meta: { name, scopes: account.scopes, ipAllowlistSize: ipAllowlist.length },
    });

    revalidatePath(`/apps/${appId}/machines`);
    return { ok: true, message: `service account "${name}" created — now issue it a key` };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not create that account' };
  }
}

export async function issueServiceKeyAction(
  _prev: MachineState,
  formData: FormData,
): Promise<MachineState> {
  try {
    const admin = await requireSuperAdmin();
    const appId = String(formData.get('appId') ?? '');
    const serviceAccountId = String(formData.get('serviceAccountId') ?? '');
    const label = String(formData.get('label') ?? '').trim() || 'service key';

    const issued = await issueServiceAccountKey(db(), serviceAccountId, admin.userId, label);

    await recordAudit(db(), {
      appId,
      actorType: 'admin',
      actorId: admin.userId,
      action: 'key.issued',
      targetType: 'service_account',
      targetId: serviceAccountId,
      meta: { prefix: issued.row.keyPrefix },
    });

    revalidatePath(`/apps/${appId}/machines`);
    return {
      ok: true,
      // Always sk_: a machine has no business in a browser.
      message: 'copy this key now — it is never shown again, and it is a secret key: server side only.',
      rawKey: issued.rawKey,
    };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not issue that key' };
  }
}

export async function revokeServiceAccountAction(
  appId: string,
  serviceAccountId: string,
): Promise<MachineState> {
  try {
    const admin = await requireSuperAdmin();
    const revoked = await revokeServiceAccount(db(), serviceAccountId);

    await recordAudit(db(), {
      appId,
      actorType: 'admin',
      actorId: admin.userId,
      action: 'service_account.revoked',
      targetType: 'service_account',
      targetId: serviceAccountId,
      meta: { keysRevoked: revoked },
    });

    revalidatePath(`/apps/${appId}/machines`);
    return { ok: true, message: `revoked, along with ${revoked} key(s)` };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not revoke that account' };
  }
}

export async function createWorkspaceAction(
  _prev: MachineState,
  formData: FormData,
): Promise<MachineState> {
  try {
    const admin = await requireSuperAdmin();
    const appId = String(formData.get('appId') ?? '');
    const name = String(formData.get('name') ?? '').trim();
    const slug = String(formData.get('slug') ?? '').trim().toLowerCase();

    if (name === '') throw new InfraError('VALIDATION_FAILED', 'give the workspace a name');
    if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug)) {
      throw new InfraError('VALIDATION_FAILED', 'slug must be lower-case letters, digits or hyphens');
    }

    const workspace = await createWorkspace(db(), { appId, name, slug, createdBy: admin.userId });

    await recordAudit(db(), {
      appId,
      actorType: 'admin',
      actorId: admin.userId,
      action: 'app.updated',
      targetType: 'workspace',
      targetId: workspace.id,
      meta: { slug },
    });

    revalidatePath(`/apps/${appId}/machines`);
    return { ok: true, message: `workspace "${slug}" created` };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not create that workspace' };
  }
}
