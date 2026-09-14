'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { InfraError } from '@infra/core';
import {
  activeImpersonation,
  endImpersonation,
  recordAudit,
  startImpersonation,
} from '@infra/db';
import { requireSuperAdmin } from '@/lib/admin';
import { db } from '@/lib/db';

export interface ImpersonationState {
  ok: boolean;
  message: string;
  sessionId?: string;
}

function clientIpFromHeaders(list: Headers): string | null {
  const forwarded = list.get('x-forwarded-for');
  if (forwarded !== null) return forwarded.split(',')[0]?.trim() ?? null;
  return list.get('x-real-ip');
}

/**
 * Every refusal lives in startImpersonation (self, other admins, weak reason, a second concurrent
 * session). This action's own job is to prove the caller is a platform admin with a fresh MFA
 * challenge — requireSuperAdmin re-checks all three conditions, because a server action must never
 * assume the page that rendered the form guarded it.
 */
export async function beginImpersonation(
  _previous: ImpersonationState,
  formData: FormData,
): Promise<ImpersonationState> {
  try {
    const admin = await requireSuperAdmin();
    const targetUserId = String(formData.get('targetUserId') ?? '');
    const reason = String(formData.get('reason') ?? '');
    const ticketRef = String(formData.get('ticketRef') ?? '').trim();
    const minutes = Number(formData.get('minutes') ?? 15);

    if (targetUserId === '') throw new InfraError('VALIDATION_FAILED', 'pick a user first');

    const session = await startImpersonation(db(), {
      actorAdminId: admin.userId,
      targetUserId,
      reason,
      ticketRef: ticketRef === '' ? null : ticketRef,
      minutes: Number.isFinite(minutes) ? minutes : 15,
      // Acting as someone has to be asked for explicitly; the default is looking.
      readOnly: formData.get('readOnly') !== 'false',
      ipAddress: clientIpFromHeaders(await headers()),
    });

    await recordAudit(db(), {
      actorType: 'admin',
      actorId: admin.userId,
      action: 'impersonation.started',
      targetType: 'user',
      targetId: targetUserId,
      ipAddress: session.ipAddress,
      // The reason is recorded in the audit trail too, so reading the log needs no second lookup.
      meta: {
        sessionId: session.id,
        reason: session.reason,
        readOnly: session.readOnly,
        expiresAt: session.expiresAt.toISOString(),
      },
    });

    revalidatePath('/', 'layout');
    return { ok: true, message: 'impersonation started', sessionId: session.id };
  } catch (error) {
    return {
      ok: false,
      message: InfraError.is(error) ? error.message : 'could not start impersonation',
    };
  }
}

export async function stopImpersonation(): Promise<ImpersonationState> {
  try {
    const admin = await requireSuperAdmin();
    const session = await activeImpersonation(db(), admin.userId);
    if (session === null) return { ok: true, message: 'nothing to end' };

    await endImpersonation(db(), session.id, 'ended');
    await recordAudit(db(), {
      actorType: 'admin',
      actorId: admin.userId,
      action: 'impersonation.ended',
      targetType: 'user',
      targetId: session.targetUserId,
      meta: { sessionId: session.id, endedReason: 'ended' },
    });

    revalidatePath('/', 'layout');
    return { ok: true, message: 'impersonation ended' };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not end impersonation' };
  }
}
