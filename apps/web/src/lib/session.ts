import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@infra/auth';

export interface AdminSession {
  userId: string;
  email: string;
  name: string;
}

export async function currentSession(): Promise<AdminSession | null> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (session === null) return null;
  return { userId: session.user.id, email: session.user.email, name: session.user.name };
}

/**
 * Plain session guard — authentication only.
 *
 * Dashboard routes use requireSuperAdmin() in lib/admin.ts instead, which also checks the email
 * allowlist, the platform-admin row and the MFA challenge. Keep this one for pages that need
 * nothing more than "somebody is signed in".
 */
export async function requireAdminSession(): Promise<AdminSession> {
  const session = await currentSession();
  if (session === null) redirect('/sign-in');
  return session;
}
