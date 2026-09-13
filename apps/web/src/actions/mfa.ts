'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { auth } from '@infra/auth';
import { InfraError, parseServerEnv, isSuperAdminEmail, superAdminEmails } from '@infra/core';
import {
  activateTotpFactor,
  markSessionMfaVerified,
  recordAudit,
  startTotpEnrolment,
  verifyMfaCode,
} from '@infra/db';
import { db } from '@/lib/db';

export interface MfaState {
  ok: boolean;
  message: string;
  secret?: string;
  otpauthUri?: string;
  factorId?: string;
  backupCodes?: string[];
}

async function currentAdmin(): Promise<{ userId: string; email: string; sessionId: string }> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (session === null) throw new InfraError('UNAUTHENTICATED', 'sign in first');

  // The allowlist is re-checked here: a server action must never trust that a page guarded it.
  if (!isSuperAdminEmail(session.user.email, superAdminEmails(parseServerEnv()))) {
    throw new InfraError('FORBIDDEN_SCOPE', 'this account is not a platform administrator');
  }
  return { userId: session.user.id, email: session.user.email, sessionId: session.session.id };
}

export async function startEnrolmentAction(): Promise<MfaState> {
  try {
    const admin = await currentAdmin();
    const enrolment = await startTotpEnrolment(
      db(),
      admin.userId,
      admin.email,
      'Unified-App-Infra',
    );
    return {
      ok: true,
      message: 'Scan or type this into your authenticator app, then enter the six digits it shows.',
      secret: enrolment.secretBase32,
      otpauthUri: enrolment.otpauthUri,
      factorId: enrolment.factorId,
    };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not start enrolment' };
  }
}

export async function activateEnrolmentAction(_prev: MfaState, formData: FormData): Promise<MfaState> {
  try {
    const admin = await currentAdmin();
    const factorId = String(formData.get('factorId') ?? '');
    const code = String(formData.get('code') ?? '');

    const result = await activateTotpFactor(db(), factorId, admin.userId, code);
    await markSessionMfaVerified(db(), admin.sessionId);
    await recordAudit(db(), {
      actorType: 'admin',
      actorId: admin.userId,
      action: 'auth.signin',
      targetType: 'mfa_factor',
      targetId: result.factor.id,
      meta: { event: 'mfa.enrolled', type: 'totp' },
    });

    revalidatePath('/apps');
    return {
      ok: true,
      message: 'Two-factor authentication is on. Save these backup codes — they are shown once.',
      backupCodes: result.backupCodes,
    };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not activate' };
  }
}

export async function verifyChallengeAction(_prev: MfaState, formData: FormData): Promise<MfaState> {
  const code = String(formData.get('code') ?? '');
  try {
    const admin = await currentAdmin();
    const verification = await verifyMfaCode(db(), admin.userId, code);
    await markSessionMfaVerified(db(), admin.sessionId);

    await recordAudit(db(), {
      actorType: 'admin',
      actorId: admin.userId,
      action: 'auth.signin',
      meta: { event: 'mfa.verified', method: verification.method },
    });

    const note =
      verification.method === 'backup_code'
        ? `Backup code accepted — ${verification.backupCodesRemaining ?? 0} left.`
        : 'Verified.';
    return { ok: true, message: note };
  } catch (error) {
    await recordAudit(db(), {
      actorType: 'admin',
      action: 'auth.signin.failed',
      outcome: 'failure',
      meta: { event: 'mfa.failed' },
    }).catch(() => {});
    return { ok: false, message: InfraError.is(error) ? error.message : 'that code is not valid' };
  }
}
