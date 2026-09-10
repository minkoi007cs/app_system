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

/** Guard for every dashboard route and server action. */
export async function requireAdminSession(): Promise<AdminSession> {
  const session = await currentSession();
  if (session === null) redirect('/sign-in');
  return session;
}
