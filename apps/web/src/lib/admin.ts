/**
 * The control-plane guard.
 *
 * Three independent conditions, all required (docs/iam-blueprint.md §0.1):
 *   1. the email is in INFRA_SUPER_ADMIN_EMAILS — an environment variable, not editable from the UI
 *   2. an active row exists in infra_platform_admins
 *   3. this session has cleared an MFA challenge in the last 8 hours
 *
 * They are separate so that one bug — a bad RBAC check, a stray insert, a stolen session — is
 * never enough on its own. Whoever holds this level can decrypt every app's database credentials.
 */
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@infra/auth';
import { isSuperAdminEmail, parseServerEnv, superAdminEmails } from '@infra/core';
import {
  ensurePlatformAdmin,
  findTrustedDevice,
  getPlatformAdmin,
  hasVerifiedMfa,
  mfaStillFresh,
  touchPlatformAdmin,
  TRUSTED_DEVICE_COOKIE,
} from '@infra/db';
import { db } from './db';

export const ADMIN_MFA_MAX_AGE_HOURS = 8;

export interface AdminContext {
  userId: string;
  email: string;
  name: string;
  sessionId: string;
  role: string;
  mfaEnrolled: boolean;
  mfaFresh: boolean;
  trustedDevice: boolean;
}

export type AdminGate =
  | { state: 'anonymous' }
  | { state: 'not-allowlisted'; email: string }
  | { state: 'needs-enrolment'; context: AdminContext }
  | { state: 'needs-challenge'; context: AdminContext }
  | { state: 'ok'; context: AdminContext };

/** Evaluates the gate without redirecting — pages decide what to do with each state. */
export async function evaluateAdminGate(): Promise<AdminGate> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (session === null) return { state: 'anonymous' };

  const allowlist = superAdminEmails(parseServerEnv());
  if (!isSuperAdminEmail(session.user.email, allowlist)) {
    return { state: 'not-allowlisted', email: session.user.email };
  }

  // First sign-in by an allowlisted email creates the admin row — no seed script needed.
  const admin = (await getPlatformAdmin(db(), session.user.id)) ?? (await ensurePlatformAdmin(db(), session.user.id));
  if (admin.status !== 'active') return { state: 'not-allowlisted', email: session.user.email };

  const mfaEnrolled = await hasVerifiedMfa(db(), session.user.id);
  const verifiedAt = (session.session as { mfaVerifiedAt?: Date | string | null }).mfaVerifiedAt ?? null;
  const parsedVerifiedAt =
    verifiedAt === null ? null : verifiedAt instanceof Date ? verifiedAt : new Date(verifiedAt);
  // A device the admin explicitly chose to remember skips the challenge until the grant expires.
  const deviceToken = (await cookies()).get(TRUSTED_DEVICE_COOKIE)?.value ?? null;
  const trusted = mfaEnrolled ? await findTrustedDevice(db(), session.user.id, deviceToken) : null;
  const mfaFresh = mfaStillFresh(parsedVerifiedAt, ADMIN_MFA_MAX_AGE_HOURS) || trusted !== null;

  const context: AdminContext = {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    sessionId: session.session.id,
    role: admin.role,
    mfaEnrolled,
    mfaFresh,
    trustedDevice: trusted !== null,
  };

  void touchPlatformAdmin(db(), session.user.id).catch(() => {});

  if (!mfaEnrolled) return { state: 'needs-enrolment', context };
  if (!mfaFresh) return { state: 'needs-challenge', context };
  return { state: 'ok', context };
}

/** Guard for every dashboard route and every admin server action. */
export async function requireSuperAdmin(): Promise<AdminContext> {
  const gate = await evaluateAdminGate();

  switch (gate.state) {
    case 'anonymous':
      redirect('/sign-in');
    // eslint-disable-next-line no-fallthrough
    case 'not-allowlisted':
      redirect('/not-authorised');
    // eslint-disable-next-line no-fallthrough
    case 'needs-enrolment':
      redirect('/security/enrol');
    // eslint-disable-next-line no-fallthrough
    case 'needs-challenge':
      redirect('/security/verify');
    // eslint-disable-next-line no-fallthrough
    case 'ok':
      return gate.context;
  }
}
