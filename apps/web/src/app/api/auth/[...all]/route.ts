/**
 * Better Auth mounts every auth endpoint here: sign-in, sign-up, OAuth callbacks, sign-out.
 * The instance is created per request (lazily) so a build never needs runtime secrets.
 */
import { auth } from '@infra/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return auth().handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return auth().handler(request);
}
