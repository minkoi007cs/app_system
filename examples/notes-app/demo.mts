/**
 * The proof, run end to end against a live hub.
 *
 * Two identities, one table. The point is not that the reads work — it is that the *second* user
 * cannot see the first one's rows, and that nothing in this file says so. The isolation lives in a
 * policy on the hub; the app code below has no idea it exists, which is exactly the property a
 * child app is supposed to get for free.
 */
import { createInfraClient } from '@infra/sdk';

const BASE_URL = process.env.INFRA_URL ?? 'http://localhost:3000';
const PUBLISHABLE = process.env.INFRA_PUBLISHABLE_KEY ?? '';
const SECRET = process.env.INFRA_SECRET_KEY ?? '';

if (SECRET === '') {
  console.error('set INFRA_SECRET_KEY (and INFRA_PUBLISHABLE_KEY) from the setup script output');
  process.exit(1);
}

/** Signs a user in and returns a client that carries their access token. */
async function asUser(email: string, password: string) {
  const infra = createInfraClient({ baseUrl: BASE_URL, apiKey: PUBLISHABLE });

  const signIn = await fetch(`${BASE_URL}/api/v1/auth/token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${PUBLISHABLE}`, 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'password', email, password }),
  });

  if (!signIn.ok) {
    console.error(`could not sign in ${email} — create the account first, or check the password`);
    process.exit(1);
  }

  const tokens = (await signIn.json()) as { data?: { access_token?: string } };
  const accessToken = tokens.data?.access_token ?? '';

  return createInfraClient({
    baseUrl: BASE_URL,
    apiKey: PUBLISHABLE,
    headers: { 'x-infra-access-token': accessToken },
  });
}

async function main(): Promise<void> {
  const alice = await asUser(process.env.USER_A ?? 'alice@example.com', process.env.PASS_A ?? '');
  const bob = await asUser(process.env.USER_B ?? 'bob@example.com', process.env.PASS_B ?? '');

  // Neither insert names an owner beyond the signed-in user; the policy refuses a row that claims
  // somebody else, and refuses one that omits owner_id entirely.
  await alice.from('notes').insert({ title: 'alice private', owner_id: 'ALICE_ID' }).run();
  await bob.from('notes').insert({ title: 'bob private', owner_id: 'BOB_ID' }).run();

  const alicesView = await alice.from('notes').select('title').rowsOnly();
  const bobsView = await bob.from('notes').select('title').rowsOnly();

  console.info('alice sees:', alicesView.data);
  console.info('bob sees:  ', bobsView.data);

  // The attempt that must fail: ask explicitly for the other person's rows.
  const attempt = await bob.from('notes').select('title').eq('owner_id', 'ALICE_ID').rowsOnly();
  console.info('bob asking for alice rows:', attempt.data, '(expected: [])');

  // And the raw-SQL endpoint, which has no rules engine at all, must refuse a publishable key.
  const raw = await createInfraClient({ baseUrl: BASE_URL, apiKey: PUBLISHABLE }).db.query(
    'select * from notes',
  );
  console.info('pk_ against /api/v1/query:', raw.error?.code, '(expected: FORBIDDEN_SCOPE)');
}

main().catch((error: unknown) => {
  console.error('demo failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
