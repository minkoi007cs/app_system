# Unified-App-Infra

A self-hosted Backend-as-a-Service: one authentication hub, one admin dashboard, and a router that
gives every child application its own free-tier database.

Built so a small set of side projects can stop re-implementing sign-in, secret storage and database
plumbing one at a time.

```ts
import { createInfraClient } from '@infra/sdk';

const infra = createInfraClient({
  baseUrl: process.env.INFRA_URL!,
  apiKey: process.env.INFRA_API_KEY!, // pk_live_… — server side only
});

const { data: session } = await infra.auth.getSession();
const { data: notes } = await infra.db.query('select id, title from notes where owner = $1', [
  session!.user.id,
]);
```

## What it does

| Capability | Detail |
|---|---|
| **Multi-database pool** | Neon PostgreSQL · Supabase PostgreSQL · Turso LibSQL. One isolated database per child app; adding a provider is one adapter file. |
| **Centralized auth** | Better Auth with email/password plus Google, GitHub and Microsoft OAuth — configured once for the whole platform, not per app. |
| **App scoping** | One global identity; `infra_app_members` decides which apps a person belongs to. A session from app A never resolves in app B. |
| **Client SDK** | `@infra/sdk`, zero runtime dependencies, Supabase-style `{ data, error }` results. |
| **Admin dashboard** | Register apps, issue/rotate/revoke API keys, attach databases, watch health, read the audit log. |

## Security model

- Tenant connection strings are sealed with **AES-256-GCM** before they are stored: random 12-byte IV
  per encryption, separate auth tag, and an AAD of `appId:configId` so a ciphertext cannot be moved
  between rows. Plaintext exists only in memory, only while a driver is constructed.
- API keys are `pk_live_` + 32 base62 characters. Only the **SHA-256 hash** is stored; the raw key is
  displayed exactly once.
- `appId` always comes from the verified API key — never from a request body or header.
- `/api/v1/query` accepts parameterised statements only. Values travel in `params` and are bound by
  the driver; nothing is concatenated into SQL anywhere in the repo.
- The audit log records statement *fingerprints*, row counts and durations — never statement text,
  parameter values, keys or connection strings.

## Layout

```
packages/core       AES-256-GCM crypto, API key generation, env validation, error taxonomy
packages/db         Drizzle schema for the Master DB, client, typed queries
packages/adapters   DatabaseAdapter contract, postgres + libsql drivers, resolver, pool, health
packages/auth       Better Auth instance, OAuth providers, app-scope plugin
packages/sdk        @infra/sdk — the client child apps install
apps/web            Next.js App Router: admin dashboard + /api/auth/* + /api/v1/*
```

## Quickstart

```bash
corepack enable && corepack prepare pnpm@9.12.0 --activate
pnpm install

cp .env.example .env.local
echo "INFRA_MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32)"   # back this up — it is not recoverable
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)"
# add INFRA_MASTER_DATABASE_URL from your Neon project

pnpm db:migrate     # creates 9 tables in the Master DB
pnpm dev            # dashboard on http://localhost:3000
```

**Tiếng Việt:** hướng dẫn tạo tài khoản Neon / Supabase / Turso từng bước nằm ở
[`docs/setup-databases.md`](docs/setup-databases.md). Kiến trúc chi tiết ở [`tech.md`](tech.md),
tiến độ và nhật ký ở [`process.md`](process.md).

## Public API

| Method | Endpoint | Scope |
|---|---|---|
| `POST` | `/api/v1/query` | `db:read`, or `db:write` when the statement mutates |
| `GET` | `/api/v1/health` | any |
| `GET` | `/api/v1/me` | `auth:read` |
| `*` | `/api/auth/*` | cookie session |

## Development

```bash
pnpm build       # turborepo: all packages + next build
pnpm test        # vitest across the workspace
pnpm typecheck   # strict, zero implicit any
pnpm db:studio   # browse the Master DB
```

## Status

Phases 1–4 are implemented. The one open task is running the generated migration against a live Neon
project (`pnpm db:migrate`), which needs credentials rather than code. See `process.md` for the
worklog and what comes next.

## License

Private project — all rights reserved.
