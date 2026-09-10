# tech.md — Unified-App-Infra · Master Architectural Blueprint

| Field | Value |
|---|---|
| Project | **Unified-App-Infra** (self-hosted BaaS / auth hub / multi-DB router) |
| Blueprint version | **v0.2.0** |
| Last updated | 2026-09-10 |
| Status | Phases 1–4 implemented except T1.7 (migration chưa chạy lên Neon) |
| Owner | Khoi Hoang (johnny.khoihoang@gmail.com) |
| Master DB provider | **Neon PostgreSQL** (free tier) |

> **Đọc file này thế nào (VN):** đây là *bản vẽ thiết kế* của cả hệ thống. Mỗi lần bắt đầu một
> phiên làm việc mới, AI đọc `tech.md` (bản vẽ) + `process.md` (nhật ký tiến độ) là đủ hiểu
> toàn bộ dự án — **không** cần quét lại toàn bộ mã nguồn. Khi kiến trúc thay đổi, sửa file này.

---

## 0. Anchor Protocol (bắt buộc mỗi phiên)

1. **Pre-Flight Anchor Check** — đọc `tech.md` rồi `process.md` ở thư mục gốc. Cấm quét đệ quy
   toàn workspace hoặc tìm kiếm rộng trong mã nguồn.
2. **Thực thi** — chỉ làm đúng "Next Task" ghi ở đầu worklog trong `process.md`.
3. **Post-Execution State Persistence** — chạy `pnpm build` và `pnpm test`; chỉ khi cả hai PASS
   mới ghi một entry mới vào **đầu** mục "Active Worklog" của `process.md` theo template có sẵn.
4. **Commit** — Conventional Commits, một commit cho một đơn vị công việc.

---

## 1. Problem Statement & Product Definition

Khoi vận hành nhiều "child app" nhỏ (web học tập, indesign-mcp, AgentUI, các app cá nhân khác).
Mỗi app hiện phải tự dựng lại: đăng nhập, database, quản lý khoá bí mật. Rất tốn thời gian và
mỗi app lại có một cách làm khác nhau.

**Unified-App-Infra** là một *backend dùng chung*, tự host, cung cấp:

| # | Capability | Tóm tắt (VN) |
|---|---|---|
| 1 | **Dynamic Multi-Free-DB Pool** | Một "hồ" database miễn phí (Supabase PG, Neon PG, Turso LibSQL). Mỗi child app được cấp một database riêng biệt, không đụng dữ liệu của nhau. |
| 2 | **Centralized Authentication Hub** | Một chỗ đăng nhập duy nhất (Google / GitHub / Microsoft / Email-Password) dùng Better Auth. User được "gắn nhãn" theo từng app (app scoping). |
| 3 | **Turnkey Client SDK** (`@infra/sdk`) | Thư viện TypeScript nhẹ. Child app chỉ cần <10 dòng là đăng nhập + query được. |
| 4 | **Admin Web Dashboard** | Next.js 15 + Shadcn UI: đăng ký app mới, cấp/thu hồi API key, xem sức khoẻ từng database. |

### Non-goals (v1)
- Không làm realtime subscriptions / websockets.
- Không làm file storage (dùng thẳng của provider nếu cần).
- Không làm billing / metering theo lượt dùng.
- Không tự động migrate schema của child app (child app tự lo schema của mình).

---

## 2. C4 Architecture Diagrams

### 2.1 Level 1 — System Context

```mermaid
graph TB
    Dev["Khoi (Platform Admin)<br/>quản trị app + khoá"]
    EndUser["End User<br/>người dùng cuối của child app"]
    ChildApp["Child Application<br/>(learning_AI, AgentUI, ...)<br/>dùng @infra/sdk"]

    subgraph UAI["Unified-App-Infra (self-hosted)"]
        Platform["Admin Dashboard + Auth Hub + DB Router"]
    end

    Neon[("Neon PostgreSQL<br/>free tier")]
    Supa[("Supabase PostgreSQL<br/>free tier")]
    Turso[("Turso LibSQL<br/>free tier")]
    OAuth["Google / GitHub / Microsoft<br/>OAuth Providers"]

    Dev -->|"HTTPS, session cookie"| Platform
    EndUser -->|"dùng app"| ChildApp
    ChildApp -->|"REST + pk_live_ API key"| Platform
    Platform -->|"OIDC / OAuth2"| OAuth
    Platform -->|"postgres-js (TLS)"| Neon
    Platform -->|"postgres-js (TLS)"| Supa
    Platform -->|"@libsql/client (TLS)"| Turso
```

### 2.2 Level 2 — Container Diagram

```mermaid
graph TB
    subgraph Repo["pnpm monorepo: unified-app-infra"]
        Web["apps/web — Next.js 15 App Router<br/>· Admin Dashboard (RSC + Server Actions)<br/>· Route Handlers: /api/auth/*, /api/v1/*"]
        SDK["packages/sdk — @infra/sdk<br/>TypeScript client, zero heavy deps"]
        DB["packages/db — @infra/db<br/>Drizzle schema Master DB + migrations"]
        Core["packages/core — @infra/core<br/>crypto (AES-256-GCM), api-key, errors, zod contracts"]
        Adapters["packages/adapters — @infra/adapters<br/>PostgresAdapter · LibsqlAdapter · Resolver · Pool cache"]
        Auth["packages/auth — @infra/auth<br/>Better Auth instance + app-scoping plugin"]
    end

    Master[("Master DB — Neon PG<br/>infra_apps · infra_api_keys<br/>infra_database_configs · infra_audit_logs")]
    Tenant[("Tenant DBs (n)<br/>PG hoặc LibSQL, 1 per child app")]

    Web --> Auth
    Web --> Adapters
    Web --> DB
    Auth --> DB
    Adapters --> Core
    DB --> Core
    SDK -.->|"HTTPS, không import server code"| Web
    DB --> Master
    Auth --> Master
    Adapters --> Tenant
```

### 2.3 Level 3 — Component: request đi qua Multi-DB Router

```mermaid
sequenceDiagram
    autonumber
    participant C as Child App (@infra/sdk)
    participant R as Route Handler /api/v1/query
    participant G as apiKeyGuard
    participant S as ConnectionResolver
    participant K as Crypto (AES-256-GCM)
    participant P as ConnectionPool (LRU cache)
    participant T as Tenant DB
    participant L as Audit Logger

    C->>R: POST /api/v1/query { sql, params }<br/>Authorization: Bearer pk_live_xxx
    R->>G: verify(rawKey)
    G->>G: sha256(rawKey) → hash
    G->>S: lookup infra_api_keys by hash (+ revoked?, expires?)
    G-->>R: { appId, scopes } | 401
    R->>S: resolve(appId)
    alt cache hit (TTL 5 phút)
        S->>P: get existing client
    else cache miss
        S->>K: decrypt(encrypted_connection_string)
        K-->>S: plaintext DSN (chỉ tồn tại trong RAM)
        S->>P: create client (PG hoặc LibSQL)
    end
    P->>T: execute parameterized query
    T-->>P: rows
    P-->>R: rows
    R->>L: insert infra_audit_logs (async, fire-and-forget)
    R-->>C: 200 { data, meta }
```

---

## 3. Monorepo Layout

```
unified-app-infra/
├── tech.md                     # ← bản vẽ kiến trúc (file này)
├── process.md                  # ← nhật ký tiến độ / state machine
├── INIT.md                     # ← lệnh khởi tạo dự án
├── package.json                # root scripts: build, test, lint, db:*
├── pnpm-workspace.yaml
├── turbo.json                  # orchestration build/test giữa các package
├── tsconfig.base.json          # strict: true, noImplicitAny: true
├── .env.example                # KHÔNG chứa giá trị thật
├── .gitignore
├── .nvmrc                      # 22
│
├── apps/
│   └── web/                            # Next.js 15 — Admin Dashboard + Public API
│       ├── src/app/
│       │   ├── layout.tsx
│       │   ├── page.tsx                # landing / redirect → /dashboard
│       │   ├── (auth)/
│       │   │   ├── sign-in/page.tsx
│       │   │   └── sign-up/page.tsx
│       │   ├── (dashboard)/
│       │   │   ├── layout.tsx          # sidebar + guard session
│       │   │   ├── apps/page.tsx       # danh sách child app
│       │   │   ├── apps/[appId]/page.tsx
│       │   │   ├── apps/[appId]/keys/page.tsx
│       │   │   ├── apps/[appId]/database/page.tsx
│       │   │   ├── health/page.tsx     # health monitoring
│       │   │   └── audit/page.tsx
│       │   └── api/
│       │       ├── auth/[...all]/route.ts        # Better Auth handler
│       │       └── v1/
│       │           ├── query/route.ts            # POST — chạy query trên tenant DB
│       │           ├── me/route.ts               # GET  — user hiện tại (app-scoped)
│       │           └── health/route.ts           # GET  — ping tenant DB
│       ├── src/actions/                # Server Actions (register app, rotate key…)
│       ├── src/components/ui/          # Shadcn UI
│       ├── src/components/             # AppTable, KeyDialog, HealthBadge…
│       ├── src/lib/                    # auth-client, guards, fetchers
│       ├── components.json             # config Shadcn
│       ├── next.config.ts
│       └── tailwind.config.ts
│
├── packages/
│   ├── core/                   # @infra/core — không phụ thuộc framework
│   │   ├── src/crypto.ts               # AES-256-GCM encrypt/decrypt
│   │   ├── src/api-key.ts              # generate pk_live_… + sha256 hash
│   │   ├── src/errors.ts               # InfraError taxonomy
│   │   ├── src/env.ts                  # zod validation lúc boot
│   │   ├── src/contracts.ts            # zod schemas dùng chung server↔SDK
│   │   ├── src/index.ts
│   │   └── tests/crypto.test.ts        # Vitest
│   │
│   ├── db/                     # @infra/db — Master DB
│   │   ├── src/schema/{apps,api-keys,database-configs,audit-logs,auth}.ts
│   │   ├── src/client.ts               # drizzle(postgres-js) singleton
│   │   ├── src/queries/                # truy vấn có kiểu, tái sử dụng
│   │   ├── drizzle.config.ts
│   │   └── migrations/
│   │
│   ├── adapters/               # @infra/adapters — Multi-DB engine
│   │   ├── src/types.ts                # interface DatabaseAdapter
│   │   ├── src/postgres.adapter.ts     # Supabase + Neon
│   │   ├── src/libsql.adapter.ts       # Turso
│   │   ├── src/resolver.ts             # appId → adapter (có cache)
│   │   ├── src/pool.ts                 # LRU + TTL + eviction
│   │   ├── src/health.ts               # ping + latency + status
│   │   └── tests/{postgres,libsql,resolver}.test.ts
│   │
│   ├── auth/                   # @infra/auth — Better Auth
│   │   ├── src/server.ts               # betterAuth({...}) instance
│   │   ├── src/app-scope.plugin.ts     # gắn appId vào user/session
│   │   ├── src/providers.ts            # Google / GitHub / Microsoft
│   │   └── src/index.ts
│   │
│   └── sdk/                    # @infra/sdk — publish cho child app
│       ├── src/client.ts               # createInfraClient()
│       ├── src/auth.ts                 # signIn / signOut / getSession
│       ├── src/db.ts                   # query / queryOne
│       ├── src/types.ts
│       └── tests/client.test.ts
│
└── tooling/
    ├── eslint-config/
    └── tsconfig/
```

**Nguyên tắc phụ thuộc (một chiều, không vòng):**

```
sdk  ──(chỉ HTTP)──▶  apps/web  ──▶  auth ──▶ db ──▶ core
                          └──────────▶ adapters ──▶ core
```
`packages/core` không được import bất cứ package nào khác. `packages/sdk` không được import
code server (không Drizzle, không Better Auth server) — nó chỉ gọi HTTP.

---

## 4. Master Database Schema (Drizzle ORM · PostgreSQL)

> 4 bảng nghiệp vụ dưới đây + các bảng do Better Auth sinh ra (`user`, `session`, `account`,
> `verification`) cùng nằm trong Master DB.

### 4.1 `infra_apps`

```ts
// packages/db/src/schema/apps.ts
import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

export const infraApps = pgTable('infra_apps', {
  id:          uuid('id').primaryKey().defaultRandom(),
  slug:        varchar('slug', { length: 63 }).notNull().unique(), // 'learning-ai'
  name:        varchar('name', { length: 128 }).notNull(),
  description: text('description'),
  ownerUserId: text('owner_user_id').notNull(),                    // → Better Auth user.id
  status:      varchar('status', { length: 16 }).notNull().default('active'),
               // 'active' | 'suspended' | 'archived'
  allowedOrigins: jsonb('allowed_origins').$type<string[]>().notNull().default([]),
  metadata:    jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt:  timestamp('archived_at', { withTimezone: true }),
}, (t) => ({
  ownerIdx:  index('infra_apps_owner_idx').on(t.ownerUserId),
  statusIdx: index('infra_apps_status_idx').on(t.status),
}));
```

### 4.2 `infra_api_keys`

```ts
// packages/db/src/schema/api-keys.ts
export const infraApiKeys = pgTable('infra_api_keys', {
  id:         uuid('id').primaryKey().defaultRandom(),
  appId:      uuid('app_id').notNull().references(() => infraApps.id, { onDelete: 'cascade' }),
  name:       varchar('name', { length: 128 }).notNull(),          // 'production web'
  keyHash:    varchar('key_hash', { length: 64 }).notNull().unique(), // sha256 hex, 64 ký tự
  keyPrefix:  varchar('key_prefix', { length: 20 }).notNull(),     // 'pk_live_a1b2c3d4' để hiển thị
  scopes:     jsonb('scopes').$type<ApiKeyScope[]>().notNull().default(['db:read']),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt:  timestamp('expires_at', { withTimezone: true }),
  revokedAt:  timestamp('revoked_at', { withTimezone: true }),
  createdBy:  text('created_by').notNull(),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  appIdx:  index('infra_api_keys_app_idx').on(t.appId),
  hashIdx: index('infra_api_keys_hash_idx').on(t.keyHash),         // lookup nóng
}));

export type ApiKeyScope = 'db:read' | 'db:write' | 'auth:read' | 'admin';
```

> **KHÔNG BAO GIỜ** lưu khoá thô. Chỉ lưu `keyHash` (SHA-256) + `keyPrefix` để người dùng nhận
> diện. Khoá thô hiện đúng **một lần** ngay sau khi tạo.

### 4.3 `infra_database_configs`

```ts
// packages/db/src/schema/database-configs.ts
export const infraDatabaseConfigs = pgTable('infra_database_configs', {
  id:       uuid('id').primaryKey().defaultRandom(),
  appId:    uuid('app_id').notNull().references(() => infraApps.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 16 }).notNull(),   // 'neon' | 'supabase' | 'turso'
  dialect:  varchar('dialect', { length: 16 }).notNull(),    // 'postgres' | 'libsql'
  label:    varchar('label', { length: 128 }).notNull(),
  isPrimary: boolean('is_primary').notNull().default(true),

  // AES-256-GCM envelope — xem §5.1
  encryptedConnectionString: text('encrypted_connection_string').notNull(),
  encryptionIv:             varchar('encryption_iv', { length: 24 }).notNull(),   // 12 bytes hex
  encryptionAuthTag:        varchar('encryption_auth_tag', { length: 32 }).notNull(), // 16 bytes hex
  encryptionKeyVersion:     integer('encryption_key_version').notNull().default(1),

  // Chỉ dùng cho hiển thị/health — không đủ để kết nối
  hostHint:   varchar('host_hint', { length: 255 }),         // 'ep-xxx.neon.tech'
  poolMax:    integer('pool_max').notNull().default(3),      // free tier → giữ số nhỏ
  healthStatus:      varchar('health_status', { length: 16 }).notNull().default('unknown'),
                     // 'healthy' | 'degraded' | 'down' | 'unknown'
  healthLatencyMs:   integer('health_latency_ms'),
  healthCheckedAt:   timestamp('health_checked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  appIdx: index('infra_db_configs_app_idx').on(t.appId),
  onePrimaryPerApp: uniqueIndex('infra_db_configs_one_primary')
    .on(t.appId).where(sql`${t.isPrimary} = true`),
}));
```

### 4.4 `infra_audit_logs`

```ts
// packages/db/src/schema/audit-logs.ts
export const infraAuditLogs = pgTable('infra_audit_logs', {
  id:         uuid('id').primaryKey().defaultRandom(),
  appId:      uuid('app_id').references(() => infraApps.id, { onDelete: 'set null' }),
  actorType:  varchar('actor_type', { length: 16 }).notNull(), // 'admin' | 'api_key' | 'system'
  actorId:    text('actor_id'),
  action:     varchar('action', { length: 64 }).notNull(),
              // 'app.created' | 'key.issued' | 'key.revoked' | 'db.config.updated'
              // 'db.query.executed' | 'auth.signin' | 'health.check'
  targetType: varchar('target_type', { length: 32 }),
  targetId:   text('target_id'),
  outcome:    varchar('outcome', { length: 16 }).notNull().default('success'), // 'success' | 'failure'
  ipAddress:  varchar('ip_address', { length: 45 }),
  userAgent:  text('user_agent'),
  meta:       jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  appTimeIdx: index('infra_audit_app_time_idx').on(t.appId, t.createdAt),
  actionIdx:  index('infra_audit_action_idx').on(t.action),
}));
```

**Quy tắc audit:** không bao giờ ghi giá trị tham số query, không ghi khoá thô, không ghi
connection string. Chỉ ghi *hình dạng* (ví dụ `{ sqlHash, rowCount, durationMs }`).

### 4.5 ER Diagram

```mermaid
erDiagram
    user ||--o{ infra_apps : owns
    infra_apps ||--o{ infra_api_keys : issues
    infra_apps ||--o{ infra_database_configs : "provisions (1 primary)"
    infra_apps ||--o{ infra_audit_logs : records
    user ||--o{ session : has
    user ||--o{ account : "oauth links"
```

---

## 5. Security Model

### 5.1 Encryption at rest — AES-256-GCM

| Item | Rule |
|---|---|
| Thuật toán | `aes-256-gcm` (Node `crypto`, không dùng thư viện ngoài) |
| Khoá | biến môi trường `INFRA_MASTER_ENCRYPTION_KEY` — **32 bytes hex = 64 ký tự** |
| IV | 12 bytes ngẫu nhiên (`randomBytes(12)`) — **mới cho mỗi lần mã hoá**, không tái dùng |
| Auth tag | 16 bytes, lưu riêng cột `encryption_auth_tag` |
| AAD | `${appId}:${configId}` — chống tráo bản ghi giữa các app |
| Key rotation | cột `encryption_key_version`; `INFRA_MASTER_ENCRYPTION_KEY_V{n}` cho khoá cũ |

```ts
// packages/core/src/crypto.ts — hợp đồng API
export interface EncryptedPayload {
  ciphertext: string;  // hex
  iv: string;          // hex, 24 ký tự
  authTag: string;     // hex, 32 ký tự
  keyVersion: number;
}
export function encryptSecret(plaintext: string, aad: string): EncryptedPayload;
export function decryptSecret(payload: EncryptedPayload, aad: string): string;
export function assertMasterKey(): Buffer; // throw sớm khi boot nếu key sai định dạng
```

**Bất biến:** plaintext connection string chỉ tồn tại trong RAM của tiến trình server, không bao
giờ đi vào log, response HTTP, thông báo lỗi, hay React Server Component payload.

### 5.2 API Keys

```
Định dạng:   pk_live_<32 ký tự base62>        (test: pk_test_<32>)
Sinh khoá:   randomBytes(24) → base62
Lưu trữ:     sha256(rawKey) hex  →  infra_api_keys.key_hash   (KHÔNG lưu raw)
Hiển thị:    key_prefix = 8 ký tự đầu sau tiền tố, phần còn lại •••
Xác thực:    hash khoá đến → tra key_hash (index) → kiểm revoked_at/expires_at → nạp app
Vòng đời:    rotate = tạo khoá mới + đặt revoked_at cho khoá cũ (không xoá, giữ audit)
```

### 5.3 Ranh giới tin cậy

1. **Trình duyệt admin → Dashboard**: session cookie của Better Auth (httpOnly, secure,
   sameSite=lax). Mọi Server Action đều kiểm tra session + quyền sở hữu app.
2. **Child app server → `/api/v1/*`**: `Authorization: Bearer pk_live_…`. Khoá `pk_live_` chỉ
   dùng ở phía server của child app, **không** nhúng vào bundle trình duyệt.
3. **Child app browser → `/api/auth/*`**: session cookie + kiểm tra origin theo
   `infra_apps.allowed_origins`.
4. **Platform → Tenant DB**: chỉ TLS (`sslmode=require`), pool nhỏ, timeout ngắn.

### 5.4 Chống SQL injection

`/api/v1/query` **chỉ** nhận query đã tham số hoá: `{ sql: string, params: unknown[] }`, và
`sql` phải là chuỗi tĩnh do child app viết. Adapter luôn dùng prepared statement
(`postgres-js` tagged template hoặc `libsql.execute({ sql, args })`). Nối chuỗi SQL bị cấm
tuyệt đối trong toàn repo (ESLint rule + code review).

### 5.5 Rate limiting & giới hạn free tier

| Giới hạn | Giá trị v1 |
|---|---|
| Query / phút / API key | 120 |
| Kích thước query payload | 64 KB |
| Timeout mỗi query | 10 s |
| Pool tối đa / tenant DB | 3 kết nối (free tier rất ít slot) |
| Idle eviction | 5 phút |

---

## 6. Centralized Auth Hub (Better Auth)

```ts
// packages/auth/src/server.ts
export const auth = betterAuth({
  database: drizzleAdapter(masterDb, { provider: 'pg' }),
  emailAndPassword: { enabled: true, requireEmailVerification: true },
  socialProviders: {
    google:    { clientId: env.GOOGLE_CLIENT_ID,    clientSecret: env.GOOGLE_CLIENT_SECRET },
    github:    { clientId: env.GITHUB_CLIENT_ID,    clientSecret: env.GITHUB_CLIENT_SECRET },
    microsoft: { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET },
  },
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  plugins: [appScopePlugin()],
  trustedOrigins: async () => loadAllowedOriginsFromMasterDb(),
});
```

**App scoping** — cùng một con người có thể là user của nhiều child app:

- `user` là danh tính toàn cục (một email = một user).
- `infra_app_members(app_id, user_id, role, joined_at)` là quan hệ user ↔ app.
- Session mang thêm `activeAppId`; mọi endpoint `/api/v1/*` đọc `appId` từ **API key**, không
  tin `appId` do client gửi lên.
- Child app chỉ nhìn thấy user thuộc chính app đó — cưỡng chế ở tầng query, không ở tầng UI.

Callback OAuth dùng chung một URL cho toàn nền tảng:
`https://<infra-domain>/api/auth/callback/{google|github|microsoft}` — nhờ vậy Khoi chỉ phải
cấu hình OAuth **một lần**, không phải làm lại cho từng app.

---

## 7. Dynamic Multi-DB Adapter Pattern

### 7.1 Interface chung

```ts
// packages/adapters/src/types.ts
export type SqlDialect = 'postgres' | 'libsql';
export type DbProvider = 'neon' | 'supabase' | 'turso';

export interface QueryRequest  { sql: string; params?: readonly unknown[]; timeoutMs?: number }
export interface QueryResult<R = Record<string, unknown>> {
  rows: R[]; rowCount: number; durationMs: number;
}
export interface HealthReport {
  status: 'healthy' | 'degraded' | 'down';
  latencyMs: number | null;
  checkedAt: Date;
  error?: string;
}

export interface DatabaseAdapter {
  readonly dialect: SqlDialect;
  readonly provider: DbProvider;
  query<R = Record<string, unknown>>(req: QueryRequest): Promise<QueryResult<R>>;
  health(): Promise<HealthReport>;
  close(): Promise<void>;
}
```

### 7.2 Resolver + cache

```ts
// packages/adapters/src/resolver.ts
export interface ResolverDeps {
  loadConfig: (appId: string) => Promise<DatabaseConfigRow | null>;
  decrypt: (row: DatabaseConfigRow) => string;   // gọi @infra/core
  now?: () => number;
}
export function createConnectionResolver(deps: ResolverDeps): {
  resolve(appId: string): Promise<DatabaseAdapter>;
  invalidate(appId: string): Promise<void>;      // gọi khi admin đổi config
  stats(): { size: number; hits: number; misses: number };
};
```

Cache: LRU `max = 25` adapter, TTL `5 phút`, evict khi idle. Trong dev với Next.js HMR, giữ
singleton trên `globalThis` để không tạo pool mới mỗi lần reload.

**Cấm:** cache *plaintext* connection string. Chỉ cache **đối tượng adapter đã khởi tạo**.

### 7.3 Chọn adapter

| Provider | Dialect | Driver | Ghi chú |
|---|---|---|---|
| Neon | postgres | `postgres-js` | `?sslmode=require`, pool nhỏ; hoặc HTTP driver cho serverless |
| Supabase | postgres | `postgres-js` | Dùng cổng pooler 6543 (pgbouncer), tắt prepare |
| Turso | libsql | `@libsql/client` | Cần `authToken`; edge-friendly |

Thêm provider mới = thêm một file adapter + một nhánh trong factory. Không sửa route handler.

### 7.4 Health monitoring

`SELECT 1` (PG) / `SELECT 1` (LibSQL) → đo latency:
`< 300ms healthy`, `300–1500ms degraded`, `timeout/error down`.
Kết quả ghi vào `infra_database_configs.health_*` và hiển thị ở `/dashboard/health`.

---

## 8. Client SDK Contract (`@infra/sdk`)

Mục tiêu: child app dùng được trong **dưới 10 dòng**.

```ts
import { createInfraClient } from '@infra/sdk';

const infra = createInfraClient({
  baseUrl: process.env.INFRA_URL!,
  apiKey:  process.env.INFRA_API_KEY!,   // pk_live_… — CHỈ phía server
});

const { data: session } = await infra.auth.getSession();
const { data: notes }   = await infra.db.query<Note>(
  'select id, title from notes where owner = $1 order by created_at desc limit 20',
  [session!.user.id],
);
```

```ts
export interface InfraClient {
  auth: {
    signIn: { email(i: { email: string; password: string }): Promise<Result<Session>>;
              social(p: 'google' | 'github' | 'microsoft'): Promise<Result<{ url: string }>> };
    signUp: { email(i: { email: string; password: string; name: string }): Promise<Result<Session>> };
    signOut(): Promise<Result<null>>;
    getSession(): Promise<Result<Session | null>>;
  };
  db: {
    query<R>(sql: string, params?: unknown[]): Promise<Result<R[]>>;
    queryOne<R>(sql: string, params?: unknown[]): Promise<Result<R | null>>;
    health(): Promise<Result<HealthReport>>;
  };
}
export type Result<T> =
  | { data: T; error: null }
  | { data: null; error: { code: InfraErrorCode; message: string; requestId: string } };
```

SDK **không bao giờ throw** cho lỗi nghiệp vụ — luôn trả `{ data, error }` (kiểu Supabase).
Chỉ throw khi cấu hình sai lúc khởi tạo. Không phụ thuộc runtime ngoài `fetch`.

### 8.1 Public API surface

| Method | HTTP | Scope cần |
|---|---|---|
| `db.query` | `POST /api/v1/query` | `db:read` (hoặc `db:write` nếu SQL ghi) |
| `db.health` | `GET /api/v1/health` | bất kỳ |
| `auth.getSession` | `GET /api/v1/me` | `auth:read` |
| `auth.signIn.*` | `POST /api/auth/…` | không cần (dùng cookie) |

---

## 9. Testing Strategy (Vitest)

| Vùng | Kiểu test | Bắt buộc cho milestone |
|---|---|---|
| `core/crypto` | unit — round-trip, sai AAD phải fail, sai authTag phải fail, IV không lặp | ✅ Phase 1 |
| `core/api-key` | unit — định dạng `pk_live_`, tính ổn định của hash, prefix | ✅ Phase 1 |
| `db` | integration nhẹ trên PG tạm (hoặc pglite) | Phase 1 |
| `auth` | unit — app scoping, rò rỉ chéo app | Phase 2 |
| `adapters` | unit với driver giả lập + integration tuỳ chọn | ✅ Phase 3 |
| `sdk` | unit — `fetch` giả lập, hình dạng `Result` | Phase 4 |

Ngưỡng: statements ≥ 80% cho `core` và `adapters`. `pnpm test` phải xanh trước khi đóng milestone.

---

## 10. Environment Variables

```bash
# ── Master DB (Neon) ─────────────────────────────────────────────
INFRA_MASTER_DATABASE_URL="postgresql://user:pass@ep-xxx.neon.tech/infra?sslmode=require"

# ── Crypto ───────────────────────────────────────────────────────
# 32 bytes hex = 64 ký tự. Sinh bằng: openssl rand -hex 32
INFRA_MASTER_ENCRYPTION_KEY=""

# ── Better Auth ──────────────────────────────────────────────────
BETTER_AUTH_SECRET=""                      # openssl rand -base64 32
BETTER_AUTH_URL="http://localhost:3000"

GOOGLE_CLIENT_ID=""       ; GOOGLE_CLIENT_SECRET=""
GITHUB_CLIENT_ID=""       ; GITHUB_CLIENT_SECRET=""
MICROSOFT_CLIENT_ID=""    ; MICROSOFT_CLIENT_SECRET=""

# ── Runtime ──────────────────────────────────────────────────────
NODE_ENV="development"
INFRA_PUBLIC_URL="http://localhost:3000"
INFRA_LOG_LEVEL="info"
```

Xác thực env bằng `zod` một lần lúc boot (`packages/core/src/env.ts`); thiếu biến → crash ngay,
không chạy nửa vời.

---

## 11. Conventions & Quality Gates

| Gate | Luật |
|---|---|
| TypeScript | `strict: true`, `noImplicitAny: true`, `noUncheckedIndexedAccess: true`. **Zero implicit any.** Cấm `as any` (ESLint error, chỉ được bỏ qua kèm comment lý do). |
| Secrets | Mọi credential ngoài đều mã hoá at rest. `.env` không bao giờ commit. |
| Tests | `pnpm build` + `pnpm test` PASS trước khi đóng milestone. |
| Commits | Conventional Commits: `feat\|fix\|docs\|refactor\|test\|chore(scope): mô tả` |
| SemVer | Blueprint + `process.md` tăng version theo từng milestone (0.x cho tới Phase 4). |
| Không quét repo | AI đọc `tech.md` + `process.md`, không quét đệ quy workspace. |

### Conventional Commit scopes
`core`, `db`, `auth`, `adapters`, `sdk`, `web`, `repo`, `docs`

---

## 12. Toolchain đã xác minh trên máy (2026-09-10)

| Tool | Version thực tế |
|---|---|
| Node | v22.23.2 |
| pnpm | 9.12.0 (qua corepack — nhớ `export PATH="$HOME/.local/bin:$PATH"`) |
| TypeScript | 7.0.2 |
| Turborepo | 2.10.12 |
| Vitest | 5.0.0 |
| Next.js | 16.3.4 (React 19.2.8) |
| Better Auth | 1.7.4 |
| Drizzle ORM | 0.45.2 (drizzle-kit 0.31.10) |
| Git | 2.34.1 |

**Trạng thái build/test gần nhất:** `pnpm build` 6/6 package PASS · `pnpm test` **95 test PASS**
(core 37 · adapters 30 · sdk 12 · db 8 · web 8).

---

## 13. Architecture Decision Log

| # | Quyết định | Lý do | Ngày |
|---|---|---|---|
| ADR-001 | pnpm workspaces + Turborepo | Cần chia sẻ type giữa server và SDK mà không publish npm; pnpm tiết kiệm ổ đĩa. | 2026-09-10 |
| ADR-002 | Neon làm Master DB | Free tier ổn định, branching để test migration, kết nối serverless nhanh. | 2026-09-10 |
| ADR-003 | AES-256-GCM thay vì AES-CBC | GCM có authentication tag → phát hiện sửa đổi ciphertext; AAD chống tráo bản ghi. | 2026-09-10 |
| ADR-004 | SHA-256 cho API key (không bcrypt) | Khoá có entropy cao (144 bit) nên không cần chống brute-force chậm; SHA-256 cho phép index lookup O(1). | 2026-09-10 |
| ADR-005 | SDK trả `Result` thay vì throw | Ergonomics kiểu Supabase, ép child app xử lý lỗi tường minh. | 2026-09-10 |
| ADR-006 | Chỉ nhận query tham số hoá qua `/api/v1/query` | Bề mặt tấn công nhỏ nhất mà vẫn linh hoạt; không cần dựng REST resource cho từng bảng. | 2026-09-10 |
| ADR-007 | Package dùng ESM (`"type": "module"`) + `moduleResolution: Bundler` | Next.js và Vitest đều là bundler; import nội bộ trong `packages/*` viết kèm `.js`, còn trong `apps/web` viết không đuôi (bundler của Next không map `.js` → `.ts`). | 2026-09-10 |
| ADR-008 | Dùng **Next.js 16.3.4** thay vì Next.js 15 như spec ban đầu | `create-next-app@latest` cài bản ổn định hiện hành (16.3.4 + React 19.2.8); hạ xuống 15 sẽ khoá dự án vào nhánh cũ, mất bản vá bảo mật. App Router / Server Actions / Route Handlers dùng y hệt. Đổi lại nếu Khoi yêu cầu. | 2026-09-10 |
| ADR-009 | Mọi truy vấn Drizzle nằm trong `@infra/db`, `@infra/auth` chỉ re-export | pnpm resolve `drizzle-orm` thành hai instance khác nhau (peer khác nhau vì `@libsql/client`), gây lỗi type khi hai package cùng gọi Drizzle. Gom về một chỗ vừa sửa lỗi vừa đúng kiến trúc. | 2026-09-10 |
| ADR-010 | Scope của `/api/v1/query` suy ra từ **câu lệnh**, không từ tham số client | Client tự khai "đây là read" thì vô nghĩa; `sqlIntent()` đọc từ khoá đầu câu (bỏ comment) nên khoá `db:read` không thể ghi dữ liệu. | 2026-09-10 |
| ADR-011 | Rate limit lưu trong bộ nhớ tiến trình | Nền tảng self-host chạy một instance; đủ dùng và không cần thêm Redis. Nếu scale ngang thì thay bằng store dùng chung. | 2026-09-10 |
