/**
 * The proof, run end to end against a live hub.
 *
 * Two identities, one table. The point is not that the reads work — it is that the *second* user
 * cannot see the first one's rows, and that nothing in this file says so. The isolation lives in a
 * policy on the hub; the app code below has no idea it exists, which is exactly the property a
 * child app is supposed to get for free.
 *
 * ── 2026-09-15 ──────────────────────────────────────────────────────────────
 * This file had never run either. Three things were wrong, and each is worth naming because each
 * would have looked fine in review:
 *
 *   1. It read `data.access_token`. The API returns `data.accessToken`. The token came back
 *      `undefined`, became `''`, and every request went out unauthenticated — which the gateway
 *      would refuse with a perfectly sensible error about a missing token.
 *   2. It inserted `owner_id: 'ALICE_ID'` — a placeholder, never replaced with a real user id. The
 *      policy requires `owner_id = subject.id`, so **both** inserts would have been refused. The
 *      comment above them described a guard rail catching a forged row; in fact every row was
 *      forged, including the honest ones.
 *   3. It assumed alice and bob already existed, with passwords nothing had ever set.
 *
 * Any one of these makes the demo fail. Together they mean the README's headline claim — a child
 * app in nine lines — had no working demonstration behind it. The nine lines were right; nobody
 * had run them.
 */
import { createInfraClient } from '@infra/sdk';

const BASE_URL = process.env.INFRA_URL ?? 'http://localhost:3000';
const PUBLISHABLE = process.env.INFRA_PUBLISHABLE_KEY ?? '';
const SECRET = process.env.INFRA_SECRET_KEY ?? '';

if (PUBLISHABLE === '' || SECRET === '') {
  console.error('set INFRA_PUBLISHABLE_KEY and INFRA_SECRET_KEY from the setup script output');
  process.exit(1);
}

/** Enough to tell two accounts apart in a log, not enough to harvest an address. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (domain === undefined || local === undefined || local === '') return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Two clients per person, and the reason is the whole architecture.
 *
 * `read` carries the publishable key — the one safe to ship in a browser bundle. `write` carries
 * the secret key, which belongs on the app's own server and nowhere else.
 *
 * This is not a convention anybody can forget to follow: `PUBLISHABLE_ALLOWED_SCOPES` caps a
 * publishable key at `db:read` and `auth:read`, "whatever an admin ticks in the UI". A pk_ key
 * cannot be granted `db:write` at all. Trying it here is how that turned from a line of code into
 * something observed — the insert came back `FORBIDDEN_SCOPE: key does not carry db:write`.
 *
 * Both clients carry the same user access token, so the policy compares against the same subject
 * either way. The key decides *what class of operation* is permitted; the token decides *whose
 * rows*. Neither substitutes for the other.
 */
interface Identity {
  email: string;
  userId: string;
  read: ReturnType<typeof createInfraClient>;
  write: ReturnType<typeof createInfraClient>;
}

async function post(path: string, body: unknown, accessToken?: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${PUBLISHABLE}`,
      'content-type': 'application/json',
      ...(accessToken === undefined ? {} : { 'x-infra-access-token': accessToken }),
    },
    body: JSON.stringify(body),
  });
}

/**
 * Signs a person in, creating the account first if it does not exist yet.
 *
 * Returns their real user id alongside the client. The id is not decoration: every row this demo
 * writes is owned by it, and the policy compares against it. A demo that makes up an id proves
 * nothing, because the only rows it can write are rows the policy must refuse.
 */
async function asUser(email: string, password: string): Promise<Identity> {
  let signIn = await post('/api/v1/auth/token', { grant_type: 'password', email, password });

  if (!signIn.ok) {
    // First run: create the account through the hub's own sign-up, the same path a real person
    // would take, then sign in.
    // `origin` is required, not optional: Better Auth refuses a state-changing call with no
    // Origin header (`MISSING_OR_NULL_ORIGIN`) because a request without one cannot be checked
    // against the trusted-origin list — and that list is what stops another site from driving
    // sign-ups on this hub. A browser always sends it; a script has to say so explicitly.
    const signUp = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ email, password, name: email.split('@')[0] }),
    });

    if (!signUp.ok) {
      // Print the hub's own explanation, not just the status. A bare `HTTP 422` sent me looking in
      // the wrong place for several minutes; the body said exactly what was wrong — the password
      // contained the account name, which the password policy refuses on purpose. An error that
      // withholds its reason costs more than the failure itself.
      const body = await signUp.text();
      console.error(`could not create ${maskEmail(email)}: HTTP ${signUp.status} ${body.slice(0, 200)}`);
      process.exit(1);
    }
    signIn = await post('/api/v1/auth/token', { grant_type: 'password', email, password });
  }

  if (!signIn.ok) {
    console.error(`could not sign in ${maskEmail(email)}: HTTP ${signIn.status}`);
    process.exit(1);
  }

  // `accessToken`, not `access_token` — the shape the hub actually returns.
  const tokens = (await signIn.json()) as { data?: { accessToken?: string } };
  const accessToken = tokens.data?.accessToken ?? '';
  if (accessToken === '') {
    console.error(`signed in ${maskEmail(email)} but got no access token back`);
    process.exit(1);
  }

  // The subject id, from the hub rather than from a guess.
  const me = await fetch(`${BASE_URL}/api/v1/me`, {
    headers: { authorization: `Bearer ${PUBLISHABLE}`, 'x-infra-access-token': accessToken },
  });
  const identity = (await me.json()) as { data?: { user?: { id?: string } } };
  const userId = identity.data?.user?.id ?? '';
  if (userId === '') {
    console.error(`could not read the user id for ${maskEmail(email)}`);
    process.exit(1);
  }

  const headers = { 'x-infra-access-token': accessToken };

  return {
    email,
    userId,
    read: createInfraClient({ baseUrl: BASE_URL, apiKey: PUBLISHABLE, headers }),
    // `allowBrowserApiKey` is not set, and must not be: the SDK refuses a secret key in a browser
    // precisely so this pattern cannot be copied into client-side code by accident.
    write: createInfraClient({ baseUrl: BASE_URL, apiKey: SECRET, headers }),
  };
}

async function main(): Promise<void> {
  // The default passwords deliberately share no substring with the addresses above: the hub
  // refuses a password containing the account's own name or email, and a demo whose defaults
  // trip that check teaches the wrong lesson on the first run.
  const alice = await asUser(
    process.env.USER_A ?? 'alice@example.com',
    process.env.PASS_A ?? 'correct-horse-battery-7',
  );
  const bob = await asUser(
    process.env.USER_B ?? 'bob@example.com',
    process.env.PASS_B ?? 'correct-horse-battery-9',
  );

  let failures = 0;
  const check = (label: string, actual: unknown, expected: unknown): void => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures += 1;
    console.info(`${ok ? 'OK  ' : 'FAIL'}  ${label}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
  };

  // Each person writes one row, owned by themselves — server-side, with the secret key.
  const aliceWrite = await alice.write.from('notes').insert({ title: 'alice private', owner_id: alice.userId }).run();
  const bobWrite = await bob.write.from('notes').insert({ title: 'bob private', owner_id: bob.userId }).run();
  // `error` is `null` on success, never `undefined` — `Result<T>` is a discriminated union, and
  // comparing against the wrong absent-value made this assertion fail while the write itself had
  // worked. A test that is red for the wrong reason wastes exactly as much time as one that is
  // green for the wrong reason; it just wastes it sooner.
  check('alice can write her own row', aliceWrite.error, null);
  check('bob can write his own row', bobWrite.error, null);

  // The forged row: bob claims a row belongs to alice. The policy evaluates the row before it is
  // written, so this never reaches the table.
  // Note which key this uses: the SECRET one, the most privileged credential the app has. The
  // policy still refuses it. Holding db:write buys the right to attempt a write, not the right to
  // write somebody else's row.
  const forged = await bob.write.from('notes').insert({ title: 'forged', owner_id: alice.userId }).run();
  check('bob CANNOT write a row owned by alice, even with sk_', forged.error !== null, true);

  // And the publishable key cannot write at all, whoever holds it.
  const browserWrite = await bob.read.from('notes').insert({ title: 'from a browser', owner_id: bob.userId }).run();
  check('pk_ cannot insert at all', browserWrite.error?.code, 'FORBIDDEN_SCOPE');

  // Reads go through the publishable key — the browser path the README advertises.
  const alicesView = await alice.read.from('notes').select('title', 'owner_id').rowsOnly();
  const bobsView = await bob.read.from('notes').select('title', 'owner_id').rowsOnly();

  // Neither query mentions owner_id as a filter. The condition comes from the hub.
  const aliceOwners = new Set((alicesView.data ?? []).map((row) => String(row['owner_id'])));
  const bobOwners = new Set((bobsView.data ?? []).map((row) => String(row['owner_id'])));

  check('alice sees only rows she owns', [...aliceOwners], [alice.userId]);
  check('bob sees only rows he owns', [...bobOwners], [bob.userId]);

  // The attempt that must fail: ask explicitly for the other person's rows. The client can narrow
  // the result, never widen it, so this returns nothing rather than an error.
  const attempt = await bob.read.from('notes').select('title').eq('owner_id', alice.userId).rowsOnly();
  check('bob asking for alice rows gets nothing', attempt.data, []);

  // And the raw-SQL endpoint, which has no rules engine at all, must refuse a publishable key.
  const raw = await createInfraClient({ baseUrl: BASE_URL, apiKey: PUBLISHABLE }).db.query('select * from notes');
  check('pk_ refused at /api/v1/query', raw.error?.code, 'FORBIDDEN_SCOPE');

  console.info(
    failures === 0
      ? '\n🟢 the app never mentions owner_id, and still each person sees only their own notes'
      : `\n🔴 ${failures} assertion(s) failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('demo failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
