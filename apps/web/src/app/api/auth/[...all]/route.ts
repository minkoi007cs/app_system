/**
 * Better Auth mounts every auth endpoint here: sign-in, sign-up, OAuth callbacks, sign-out.
 * The instance is created per request (lazily) so a build never needs runtime secrets.
 *
 * POSTs go through the shield first — sign-in throttling and weak/breached password refusal.
 * See lib/auth-shield.ts for what it enforces and why it lives outside the library.
 */
import { auth } from '@infra/auth';
import { shieldAuthRequest } from '@/lib/auth-shield';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return auth().handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return shieldAuthRequest(request, (forwarded) => auth().handler(forwarded));
}
