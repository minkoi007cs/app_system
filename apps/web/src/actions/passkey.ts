'use server';

import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@infra/auth';
import {
  auth,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  relyingPartyFrom,
  startPasskeyAuthentication,
  startPasskeyRegistration,
} from '@infra/auth';
import { InfraError, isSuperAdminEmail, parseServerEnv, superAdminEmails } from '@infra/core';
import {
  markSessionMfaVerified,
  recordAudit,
  removeMfaFactor,
  revokeAllTrustedDevices,
  trustDevice,
  TRUSTED_DEVICE_COOKIE,
  TRUSTED_DEVICE_TTL_DAYS,
} from '@infra/db';
import { db } from '@/lib/db';

export interface PasskeyState {
  ok: boolean;
  message: string;
  options?: unknown;
}

async function currentAdmin(): Promise<{ userId: string; email: string; name: string; sessionId: string }> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (session === null) throw new InfraError('UNAUTHENTICATED', 'sign in first');
  if (!isSuperAdminEmail(session.user.email, superAdminEmails(parseServerEnv()))) {
    throw new InfraError('FORBIDDEN_SCOPE', 'this account is not a platform administrator');
  }
  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    sessionId: session.session.id,
  };
}

function relyingParty() {
  return relyingPartyFrom(parseServerEnv().INFRA_PUBLIC_URL);
}

export async function startPasskeyRegistrationAction(): Promise<PasskeyState> {
  try {
    const admin = await currentAdmin();
    const options = await startPasskeyRegistration(db(), relyingParty(), {
      id: admin.userId,
      email: admin.email,
      name: admin.name,
    });
    return { ok: true, message: 'Follow your browser prompt.', options };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not start' };
  }
}

export async function finishPasskeyRegistrationAction(
  response: RegistrationResponseJSON,
  label: string,
): Promise<PasskeyState> {
  try {
    const admin = await currentAdmin();
    await finishPasskeyRegistration(db(), relyingParty(), { userId: admin.userId, response, label });
    await markSessionMfaVerified(db(), admin.sessionId);
    await recordAudit(db(), {
      actorType: 'admin',
      actorId: admin.userId,
      action: 'auth.signin',
      meta: { event: 'passkey.registered' },
    });
    revalidatePath('/security/sessions');
    return { ok: true, message: 'Passkey added.' };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not add that passkey' };
  }
}

export async function startPasskeyAuthenticationAction(): Promise<PasskeyState> {
  try {
    const admin = await currentAdmin();
    const options = await startPasskeyAuthentication(db(), relyingParty(), admin.userId);
    return { ok: true, message: 'Follow your browser prompt.', options };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not start' };
  }
}

export async function finishPasskeyAuthenticationAction(
  response: AuthenticationResponseJSON,
  rememberDevice: boolean,
): Promise<PasskeyState> {
  try {
    const admin = await currentAdmin();
    await finishPasskeyAuthentication(db(), relyingParty(), { userId: admin.userId, response });
    await markSessionMfaVerified(db(), admin.sessionId);
    if (rememberDevice) await rememberThisDevice(admin.userId);

    await recordAudit(db(), {
      actorType: 'admin',
      actorId: admin.userId,
      action: 'auth.signin',
      meta: { event: 'passkey.verified' },
    });
    return { ok: true, message: 'Verified.' };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'that passkey did not verify' };
  }
}

/** Issues the remember-me token and drops it in an httpOnly cookie. */
export async function rememberThisDevice(userId: string): Promise<void> {
  const grant = await trustDevice(db(), userId, 'Remembered browser');
  (await cookies()).set(TRUSTED_DEVICE_COOKIE, grant.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: TRUSTED_DEVICE_TTL_DAYS * 24 * 60 * 60,
  });
}

export async function forgetAllDevicesAction(): Promise<PasskeyState> {
  try {
    const admin = await currentAdmin();
    const count = await revokeAllTrustedDevices(db(), admin.userId);
    (await cookies()).delete(TRUSTED_DEVICE_COOKIE);
    revalidatePath('/security/sessions');
    return { ok: true, message: `${count} remembered device(s) cleared — all will be challenged again.` };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not clear devices' };
  }
}

export async function removeFactorAction(factorId: string): Promise<PasskeyState> {
  try {
    const admin = await currentAdmin();
    await removeMfaFactor(db(), factorId, admin.userId);
    await recordAudit(db(), {
      actorType: 'admin',
      actorId: admin.userId,
      action: 'auth.signin',
      targetType: 'mfa_factor',
      targetId: factorId,
      meta: { event: 'mfa.factor_removed' },
    });
    revalidatePath('/security/sessions');
    return { ok: true, message: 'Removed.' };
  } catch (error) {
    return { ok: false, message: InfraError.is(error) ? error.message : 'could not remove it' };
  }
}
