# Unified-App-Infra

A self-hosted Backend-as-a-Service: one authentication hub, one admin dashboard, and a router that
gives every child application its own free-tier database.

Built so a small set of side projects can stop re-implementing sign-in, secret storage and database
plumbing one at a time.

```ts
import { createInfraClient } from '@infra/sdk';

const infra = createInfraClient({
  baseUrl: process.env.INFRA_URL!,
  apiKey: process.env.INFRA_PUBLISHABLE_KEY!, // pk_live_… — safe in a browser bundle
});

const { data: notes } = await infra
  .from('notes')
  .select('id', 'title', 'created_at')
  .eq('done', false)
  .order('created_at', 'desc')
  .limit(20)
  .execute();
```

That query never mentions `owner_id`, and the person still gets back only their own notes. The row
filter lives in a policy on the hub and is ANDed into the statement by the same call that builds it,
so a client can narrow the result and never widen it. That property is what makes the publishable
key above safe to ship inside a browser bundle.

## What it does

| Capability | Detail |
|---|---|
| **Multi-database pool** | Neon PostgreSQL · Supabase PostgreSQL · Turso LibSQL. One isolated database per child app; adding a provider is one adapter file. |
| **Auto-provisioning** | Creating an app can create its database: one Neon *project* (not a branch — projects are what Neon isolates) or one Turso database with a token scoped to it alone. |
| **Centralized auth** | Better Auth with email/password plus Google, GitHub and Microsoft OAuth, TOTP, WebAuthn passkeys, trusted devices, and refresh-token rotation with reuse detection. |
| **Authorization** | RBAC for *whether*, ABAC policies for *which rows*. Default deny; an explicit deny beats every allow. |
| **Data gateway** | A typed query DSL compiled to parameterised SQL for both dialects, with the policy condition injected server-side. |
| **Client SDK** | `@infra/sdk`, zero runtime dependencies, `{ data, error }` results, and a request-scoped server client with single-flight token refresh. |
| **Admin dashboard** | Register apps, issue keys, attach databases, write policies (and see the SQL they compile to), manage service accounts, run audited impersonation. |

## Security model

- **Two endpoints, deliberately different.** `/api/v1/data/:resource` takes the query DSL and always
  carries a policy condition — safe for a `pk_` key. `/api/v1/query` takes raw SQL, has no rules
  engine, and accepts `sk_` only. The split is the reason a publishable key can exist at all.
- **No escape hatch in the DSL.** No `raw`, no SQL fragment, no free-text `having`. Every string that
  reaches the statement is a keyword the compiler chose or an identifier that passed a strict
  pattern; every caller value becomes a bound parameter. One escape hatch would make the other
  ninety-nine rules decorative.
- Tenant connection strings are sealed with **AES-256-GCM** before storage: random 12-byte IV, a
  separate auth tag, and an AAD bound to the row so a ciphertext cannot be moved between records.
  Plaintext exists only in memory, only while a driver is constructed.
- API keys are `pk_live_`/`sk_live_` + 32 base62 characters. Only the **SHA-256 hash** is stored; the
  raw key is displayed exactly once. A secret key arriving from a browser is refused and burned.
- `appId` always comes from the verified API key — never from a request body or header. The subject
  always comes from the verified access token.
- Sign-in is throttled per (IP, email) and per IP, with every answer padded to the same duration, so
  "no such account" and "wrong password" are indistinguishable by status code or stopwatch.
- New passwords are checked against Have I Been Pwned by **k-anonymity**: only the first five
  characters of the SHA-1 are sent, and matching happens locally.
- Outbound webhooks are signed `HMAC-SHA256` over `timestamp.body`, refuse redirects, and cannot be
  pointed at loopback, private, link-local or metadata addresses.
- The audit log records statement *shapes*, row counts and durations — never statement text,
  parameter values, keys or connection strings.

## Layout

```
packages/core       crypto, API keys, JWT, TOTP, RBAC/ABAC, query DSL + compiler, throttling
packages/db         Drizzle schema for the Master DB (31 tables), client, typed queries
packages/adapters   DatabaseAdapter contract, postgres + libsql drivers, resolver, provisioning
packages/auth       Better Auth instance, tokens, passkeys, access checks, the data gateway
packages/sdk        @infra/sdk — browser client, server client, query builder, token manager
apps/web            Next.js App Router: admin dashboard + /api/auth/* + /api/v1/*
examples/notes-app  A child app in nine lines, plus an idempotent setup script
```

## Quickstart

```bash
corepack enable && corepack prepare pnpm@9.12.0 --activate
pnpm install

cp .env.example .env.local
echo "INFRA_MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)"
```

Back up `INFRA_MASTER_ENCRYPTION_KEY` before going further — it decrypts every tenant connection
string, and there is no recovery path if it is lost. Then add `INFRA_MASTER_DATABASE_URL` from your
Neon project and run:

```bash
pnpm db:migrate     # 14 migrations, 31 tables
pnpm dev            # dashboard on http://localhost:3000
```

**Tiếng Việt:** hướng dẫn tạo tài khoản Neon / Supabase / Turso từng bước nằm ở
[`docs/setup-databases.md`](docs/setup-databases.md). Kiến trúc chi tiết ở [`tech.md`](tech.md),
tiến độ và nhật ký ở [`process.md`](process.md).

## Development

```bash
pnpm build       # turborepo: all packages + next build
pnpm test        # vitest across the workspace
pnpm typecheck   # strict, zero implicit any
pnpm db:studio   # browse the Master DB
```

## Status

All eight phases are implemented — **550 tests**, 6/6 packages building — and the platform has been
exercised against live infrastructure rather than only against mocks. All twelve migrations are
applied to the Neon Master DB (31 tables), and `scripts/live-proof.mjs` drives a real tenant
database through the rules engine: eleven checks covering per-owner read isolation, a resource with
no policy compiling to `1 = 0`, an insert forged under another user's name, and an update reaching
across owners. All eleven land correctly.

Three things found by running the system rather than testing it, all since fixed:

- **Email/password sign-in was completely broken**, and it looked exactly like a wrong password.
  The app-scope plugin declared `fieldName: 'active_app_id'` — the real database column name — but
  Better Auth's Drizzle adapter addresses a column by the Drizzle object's *property key*
  (`activeAppId`). The adapter refused to start, `signInEmail` threw, and the token route catches
  every failure from it and answers `401 invalid email or password` by design, so an unknown email
  and a wrong password stay indistinguishable. A total outage wore the costume of a typo.
  `scripts/auth-proof.mjs` now drives the whole flow — rotation, replay, family revocation — over
  HTTP against a real Postgres: 28 of 28 assertions hold.

- `expireImpersonations` and the shared rate-limit counter had **never worked** — a `Date`
  interpolated into a raw `sql` template loses the column's type mapper and reaches Postgres as
  unparseable text. 518 tests were green because nothing in the suite spoke to a real Postgres. CI
  now runs one, and `packages/db/tests/integration.test.ts` is the guard.
- `/api/internal/maintenance` returned HTTP 200 while reporting a failed job in the body, which
  defeats the `curl -f` the cron runbook depends on. A failed job is now a 500.

The encryption-key rotation drill has been run end to end (four tables, 9 ciphertexts, versions
1→2→3) and caught a real bug in the rotation tool itself. `scripts/rotate-master-key.mjs` is the
tool; `docs/runbooks.md` §2 is the procedure.

Five paths have now been driven end to end against a real Postgres — **99 assertions**, all
holding. Each writes a redacted log to `logs/`:

```bash
pnpm verify:live          # schema + migration state
node scripts/live-proof.mjs   # 11 · policy enforced on real tenant data
pnpm proof:auth           # 28 · sign-in, rotation, replay, family revocation, revoke
pnpm proof:mfa            # 27 · TOTP enrolment, replay refusal, backup codes
pnpm proof:ops            # 44 · impersonation guards, webhook SSRF, retry backoff, breaker
pnpm proof:mail you@x     #  5 · a real email through the configured provider
INFRA_TEST_DATABASE_URL=... pnpm test   # includes the integration suite
```

`examples/notes-app` now runs too — 8 of 8 assertions, against a real Postgres over HTTP. It had
never run before 2026-09-15: `setup.mts` imported a function that does not exist, so the import
alone threw. `pnpm typecheck` did not cover `examples/`, which is why nobody found out. It does now.

That run also corrected the example's architecture. A publishable key is capped at `db:read` and
`auth:read` — it can never hold `db:write` — so the demo's writes were impossible by design. It
now keeps two clients per person: reads go through the `pk_` key (the browser path advertised
above), writes through the `sk_` key (the server path). **The key decides what class of operation
is permitted; the access token decides whose rows.** The demo proves both: bob holding the `sk_`
key, the most privileged credential the app has, still cannot write a row owned by alice.

Still never run for real, and named here so nobody mistakes the list above for coverage:
passkey/WebAuthn (needs a real browser), the dashboard UI, and Neon/Turso auto-provisioning
(needs API keys — the code has never called either provider).

Mail sends for real: a message went through Resend in 204ms on 2026-09-15. One honest caveat —
with Resend's sandbox `from` address (`onboarding@resend.dev`) delivery only reaches the Resend
account owner, so password recovery is correct but **not yet usable by real users**. Verifying a
domain at resend.com/domains and changing `INFRA_MAIL_FROM` is what opens that up.

What remains before a v1.0 tag is operational, not architectural: that domain verification, a
backup restore drill, the maintenance cron installed on the target host, and Turso configured once.
See the "v1.0 readiness" section of `process.md`, and `docs/runbooks.md` for the procedures.

## License

Private project — all rights reserved.
