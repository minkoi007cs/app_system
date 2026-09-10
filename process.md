# process.md — Unified-App-Infra · Living State Machine

| Field | Value |
|---|---|
| Current version | **v0.1.4** |
| Current phase | **Phase 1 (còn T1.7) · Phase 3 (xong T3.1–T3.6, T3.9)** |
| Phase status | `IN PROGRESS` — chờ Neon để đóng Phase 1; Phase 3 chỉ còn phần route handler (cần apps/web) |
| Last build | `PASS` — 5/5 packages (turbo 2.10.12) |
| Last test | `PASS` — 8 test files, 75 tests (vitest 5.0.0) |
| Next task | **T1.7 — chạy migration lên Neon Master DB** (chờ Khoi, xem `docs/setup-databases.md`) · song song có thể làm **T4.8 SDK** |

> **File này là gì (VN):** đây là *nhật ký sống* của dự án. `tech.md` trả lời "hệ thống được
> thiết kế thế nào", còn `process.md` trả lời "hiện đang làm tới đâu, việc tiếp theo là gì".
> Mỗi lần hoàn thành một việc, ghi thêm **một entry ở trên cùng** mục Active Worklog.

---

## 1. Operating Protocol

**Mỗi phiên làm việc:**

```
1. Pre-Flight Anchor Check   → đọc tech.md, rồi process.md. KHÔNG quét đệ quy workspace.
2. Xác định Next Task        → lấy từ entry trên cùng của Active Worklog (§4).
3. Thực thi                  → chỉ làm đúng task đó.
4. Verify                    → pnpm build && pnpm test   (cả hai phải PASS)
5. Persist                   → ghi entry mới lên ĐẦU Active Worklog theo template §4.0
6. Commit                    → Conventional Commits
```

**Quy tắc tăng version (SemVer trong giai đoạn 0.x):**

| Loại thay đổi | Tăng |
|---|---|
| Task nhỏ trong phase (thêm util, thêm test) | PATCH → `v0.1.1` |
| Đóng một milestone / hoàn thành một Phase | MINOR → `v0.2.0` |
| Nền tảng đủ chạy production cho child app đầu tiên | `v1.0.0` |

**Lệnh hay dùng** (mỗi phiên mới phải nạp lại pnpm vào PATH):

```bash
export PATH="$HOME/.local/bin:$PATH"     # corepack shim của pnpm
cd ~/Documents/AI_system/unified-app-infra
pnpm install && pnpm build && pnpm test
```

---

## 2. Roadmap — Phase Checkboxes

### Phase 1 — Foundation, Security & Master DB Setup  `IN PROGRESS`
- [x] **T1.1** Khởi tạo monorepo (pnpm workspaces + Turborepo + `tsconfig.base.json` strict)
- [x] **T1.2** `packages/core`: `crypto.ts` (AES-256-GCM encrypt/decrypt + AAD + key version)
- [x] **T1.3** `packages/core`: `api-key.ts` (sinh `pk_live_…`, hash SHA-256, tách prefix)
- [x] **T1.4** `packages/core`: `env.ts` (zod), `errors.ts` (InfraError taxonomy)
- [x] **T1.5** Vitest cho `core` — crypto round-trip, sai AAD/authTag phải fail, format khoá
- [x] **T1.6** `packages/db`: schema Drizzle 4 bảng `infra_*` + bảng Better Auth + `infra_app_members`
- [ ] **T1.7** Chạy migration `0000` lên Neon Master DB — ⛔ **chờ `INFRA_MASTER_DATABASE_URL`**
      (file migration đã sinh sẵn offline: `packages/db/migrations/0000_tan_random.sql`, 9 bảng)
- [x] **T1.8** `packages/db/src/queries/` — truy vấn có kiểu cho apps / keys / configs / audit
- [ ] **G1** ✅ Gate: `pnpm build` PASS · `pnpm test` PASS · zero implicit any → bump **v0.2.0**

### Phase 2 — Centralized Auth Hub  `NOT STARTED`
- [ ] **T2.1** `packages/auth`: khởi tạo Better Auth + Drizzle adapter trên Master DB
- [ ] **T2.2** Email/Password + xác minh email
- [ ] **T2.3** OAuth Google · GitHub · Microsoft (callback dùng chung toàn nền tảng)
- [ ] **T2.4** `app-scope.plugin.ts` + bảng `infra_app_members`
- [ ] **T2.5** Route handler `apps/web/src/app/api/auth/[...all]/route.ts`
- [ ] **T2.6** `trustedOrigins` động đọc từ `infra_apps.allowed_origins`
- [ ] **T2.7** Test: cách ly user giữa các app (không rò rỉ chéo)
- [ ] **G2** ✅ Gate → bump **v0.3.0**

### Phase 3 — Dynamic Multi-DB Adapter  `IN PROGRESS`
- [x] **T3.1** `packages/adapters`: interface `DatabaseAdapter` + `types.ts`
- [x] **T3.2** `postgres.adapter.ts` (Neon + Supabase qua `postgres-js`, `prepare: false` cho pooler)
- [x] **T3.3** `libsql.adapter.ts` (Turso qua `@libsql/client`, tách authToken khỏi DSN)
- [x] **T3.4** `resolver.ts` — appId → adapter, giải mã đúng lúc cần, gộp các miss đồng thời
- [x] **T3.5** `pool.ts` — LRU 25 + TTL 5 phút + đóng adapter khi evict
- [x] **T3.6** `health.ts` — ping, phân loại latency, `worstStatus`, kiểm tra nhiều app song song
- [ ] **T3.7** `apiKeyGuard` + route `POST /api/v1/query`, `GET /api/v1/health` — ⛔ cần `apps/web` (T4.1)
- [ ] **T3.8** Ghi `infra_audit_logs` bất đồng bộ — ⛔ cùng điều kiện với T3.7
- [x] **T3.9** Vitest cho adapters + resolver (driver giả lập) — 30 test
- [ ] **G3** ✅ Gate → bump **v0.4.0**

### Phase 4 — Admin Dashboard & Client SDK  `NOT STARTED`
- [ ] **T4.1** `apps/web`: Next.js 15 App Router + Tailwind + Shadcn UI + Lucide
- [ ] **T4.2** Sign-in / sign-up cho admin + guard layout dashboard
- [ ] **T4.3** CRUD app (Server Actions): tạo, sửa, đình chỉ, lưu trữ
- [ ] **T4.4** Quản lý API key: cấp (hiện raw đúng một lần), xoay vòng, thu hồi
- [ ] **T4.5** Quản lý database config: chọn provider, dán DSN → mã hoá ngay
- [ ] **T4.6** Trang Health monitoring (badge, latency, kiểm tra thủ công)
- [ ] **T4.7** Viewer `infra_audit_logs` có lọc
- [ ] **T4.8** `packages/sdk`: `createInfraClient()` + auth + db + kiểu `Result`
- [ ] **T4.9** README quickstart "dưới 10 dòng" + tích hợp thử với một child app thật
- [ ] **G4** ✅ Gate → bump **v1.0.0**

---

## 3. Next Task — chi tiết

> **T1.7 — Đưa schema lên Neon Master DB** ⛔ *blocked: cần Khoi tạo tài khoản Neon*
>
> Các bước Khoi làm (chi tiết trong `docs/setup-databases.md`, Phần 1):
> 1. Tạo tài khoản Neon → project `infra-master` → copy connection string.
> 2. `cp .env.example .env.local`, dán chuỗi vào `INFRA_MASTER_DATABASE_URL`.
> 3. Sinh `INFRA_MASTER_ENCRYPTION_KEY` (`openssl rand -hex 32`) + `BETTER_AUTH_SECRET`,
>    **sao lưu khoá mã hoá vào password manager**.
> 4. `pnpm db:migrate` → tạo 9 bảng; `pnpm db:studio` để xem.
>
> Xong bước này → đóng gate **G1**, bump **v0.2.0**, sang Phase 2 (Better Auth).
> Trong lúc chờ, có thể làm trước Phase 3 (adapters) vì không cần Master DB thật.

---

## 4. Active Worklog  *(mới nhất ở trên cùng)*

### 4.0 Template — copy khối này lên đầu §4 cho mỗi lần hoàn thành task

```markdown
### YYYY-MM-DD · vX.Y.Z · <type>(<scope>): <mô tả conventional commit>

**Deliverables**
- …

**Modified files**
- `path/to/file.ts` (new | edit | delete)

**Test status**
- `pnpm build` → PASS | FAIL (chi tiết)
- `pnpm test`  → PASS (n passed / m total) | FAIL

**Notes / decisions**
- …

**Next task** → `T?.?` …
```

---

### 2026-09-10 · v0.1.3 · feat(db): add master db schema, client and typed queries

**Deliverables**
- Schema Drizzle đầy đủ, 9 bảng: `infra_apps`, `infra_api_keys`, `infra_database_configs`,
  `infra_audit_logs`, `infra_app_members`, + `user` / `session` / `account` / `verification`
  của Better Auth. `session.active_app_id` sẵn cho app scoping ở Phase 2.
- `client.ts` — pool postgres-js singleton giữ trên `globalThis` (an toàn với HMR), `max: 5`,
  `prepare: false` để tương thích pgbouncer.
- `queries/apps.ts` — tạo app, kiểm slug, lấy theo id/slug, đổi trạng thái, gom `trustedOrigins`.
- `queries/api-keys.ts` — cấp khoá (raw trả về đúng một lần), `verifyApiKey` (format → tra hash →
  revoked → expired → app active), rotate, revoke, stamp `last_used_at`.
- `queries/database-configs.ts` — mã hoá DSN trước khi ghi, `revealConnectionString` giải mã
  đúng lúc dùng, `hostHintOf` chỉ lấy host (không kèm credential), ghi kết quả health.
- `queries/audit-logs.ts` — `sqlFingerprint` (hash 16 ký tự thay cho câu SQL), ghi audit
  fire-and-forget để không chặn request.
- Migration `0000_tan_random.sql` sinh offline bằng drizzle-kit (9 bảng, 12 index, 8 FK).
- `docs/setup-databases.md` — hướng dẫn tiếng Việt tạo Neon / Supabase / Turso.

**Modified files**
- `packages/db/src/schema/{apps,api-keys,database-configs,audit-logs,auth,relations,index}.ts` (new)
- `packages/db/src/{client,index}.ts` · `packages/db/src/queries/{apps,api-keys,database-configs,audit-logs,index}.ts` (new)
- `packages/db/drizzle.config.ts` · `packages/db/migrations/0000_tan_random.sql` (new)
- `packages/db/tests/queries.test.ts` (new)
- `docs/setup-databases.md` (new)

**Test status**
- `pnpm build` → **PASS** (6 successful, 6 total)
- `pnpm test`  → **PASS** (45 passed / 45 total — core 37, db 8)

**Notes / decisions**
- Quan hệ Drizzle gom vào `schema/relations.ts` để các file bảng không import vòng nhau.
- `drizzle-orm@0.45` dùng dạng **mảng** cho extra config: `(t) => [index(...), uniqueIndex(...)]`.
- Partial unique index `infra_db_configs_one_primary` đảm bảo mỗi app chỉ có đúng 1 DB primary.
- Test tầng db chỉ phủ hàm thuần (slug, dialect, host hint, envelope, fingerprint) — phần chạm
  DB thật để dành cho integration test sau khi có Neon.

**Next task** → `T1.7` Chạy `pnpm db:migrate` lên Neon (chờ Khoi tạo tài khoản).

---

### 2026-09-10 · v0.1.2 · feat(core): add aes-256-gcm crypto, api key and env primitives

**Deliverables**
- `crypto.ts` — AES-256-GCM: IV 12 bytes ngẫu nhiên mỗi lần, auth tag 16 bytes lưu riêng,
  AAD `appId:configId` buộc ciphertext vào đúng bản ghi, `keyVersion` sẵn cho xoay khoá.
  Thông báo lỗi cố tình mơ hồ (sai khoá / sai AAD / bị sửa đều như nhau).
- `api-key.ts` — sinh `pk_live_` + 32 ký tự base62 (rejection sampling, không lệch phân phối),
  hash SHA-256, prefix hiển thị 8 ký tự, `maskApiKey`, `hasScope` (admin bao trùm mọi scope),
  đọc token từ header `Authorization: Bearer`.
- `env.ts` — schema zod cho toàn bộ biến môi trường; lỗi chỉ nêu **tên biến**, không in giá trị.
  `configuredOAuthProviders()` cho biết provider nào đã cấu hình đủ cặp id/secret.
- `errors.ts` — `InfraError` + 19 mã lỗi + ánh xạ HTTP status.

**Modified files**
- `packages/core/src/{crypto,api-key,env,errors,index}.ts` (new)
- `packages/core/tests/{crypto,api-key,env}.test.ts` (new), `tests/smoke.test.ts` (delete)
- `packages/{core,db,adapters,auth}/tsconfig.json` (edit — thêm `"types": ["node"]`)
- `packages/sdk/tsconfig.json` (edit — `lib: ES2022 + DOM`, không dùng type Node)

**Test status**
- `pnpm build` → **PASS** (5 successful, 5 total)
- `pnpm test`  → **PASS** (37 passed / 37 total)

**Notes / decisions**
- TypeScript 7 **không tự nhận** `@types/node` trong layout pnpm — phải khai báo tường minh
  `"types": ["node"]` trong tsconfig của từng package dùng API Node. Ghi nhớ cho package mới.
- Test khẳng định plaintext không xuất hiện trong payload và giá trị env không lọt vào message lỗi.

---

### 2026-09-10 · v0.1.1 · chore(repo): scaffold pnpm monorepo with turborepo and strict typescript

**Deliverables**
- Monorepo pnpm workspaces (`apps/*`, `packages/*`) + Turborepo task graph (build / test / typecheck / lint / dev).
- `tsconfig.base.json` bật `strict`, `noImplicitAny`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- 5 package stub có `package.json` + `tsconfig.json` + `src/index.ts`:
  `@infra/core`, `@infra/db`, `@infra/adapters`, `@infra/auth`, `@infra/sdk`.
- Toolchain gốc: turbo 2.10.12, typescript 7.0.2, vitest 5.0.0, tsx, @types/node.
- Smoke test đầu tiên trong `@infra/core` để xác minh đường ống test chạy thật.
- `.env.example`, `.gitignore`, `.nvmrc` (node 22), git repo khởi tạo trên nhánh `main`.

**Modified files**
- `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json` (new)
- `.gitignore`, `.nvmrc`, `.env.example` (new)
- `packages/{core,db,adapters,auth,sdk}/package.json` · `tsconfig.json` · `src/index.ts` (new)
- `packages/core/tests/smoke.test.ts` (new)

**Test status**
- `pnpm build` → **PASS** (5 successful, 5 total)
- `pnpm test`  → **PASS** (1 passed / 1 total)

**Notes / decisions**
- pnpm không có sẵn trên máy → kích hoạt qua corepack vào `~/.local/bin`.
  **Mỗi shell mới phải `export PATH="$HOME/.local/bin:$PATH"`.**
- pnpm cần quyền xoá file tạm trong thư mục dự án → đã cấp quyền xoá cho `AI_system`.
- **Sự cố:** lần cấp quyền đó khiến thư mục kết nối bị gắn lại và **mất toàn bộ file đã ghi
  trước đó**; `tech.md` / `process.md` / `INIT.md` đã được tạo lại nguyên vẹn. Từ nay mọi file
  tài liệu được giữ thêm một bản sao trong phiên làm việc trước khi ghi xuống máy.
- TypeScript trên máy là **7.0.2** (không phải 5.x như spec ban đầu) — mọi cờ strict vẫn
  tương thích, ghi nhận trong `tech.md` §12.
- Package dùng ESM + `moduleResolution: Bundler` (ADR-007).

**Next task** → `T1.2` Viết `packages/core/src/crypto.ts` (AES-256-GCM).

---

### 2026-09-10 · v0.1.0 · docs(repo): initialize architectural blueprint and state machine

**Deliverables**
- `tech.md` — Master Architectural Blueprint: C4 (context / container / sequence), cây monorepo,
  schema Drizzle cho `infra_apps` · `infra_api_keys` · `infra_database_configs` · `infra_audit_logs`,
  mô hình bảo mật AES-256-GCM, hợp đồng adapter đa DB, hợp đồng `@infra/sdk`, quality gates, ADR log.
- `process.md` — Living State Machine: protocol vận hành, roadmap 4 phase với checkbox,
  quy tắc SemVer, template worklog.
- `INIT.md` — lệnh khởi tạo từng bước.

**Modified files**
- `tech.md`, `process.md`, `INIT.md` (new)

**Test status**
- `pnpm build` → `n/a` — chưa có mã nguồn
- `pnpm test`  → `n/a` — chưa có mã nguồn

**Notes / decisions**
- Master DB chốt: **Neon PostgreSQL** free tier (ADR-002).
- Vị trí repo: `~/Documents/AI_system/unified-app-infra`.
- Tài liệu viết tiếng Anh kỹ thuật + chú thích tiếng Việt theo yêu cầu của Khoi.

**Next task** → `T1.1` Khởi tạo monorepo skeleton.

---

## 5. Risk Register

| # | Rủi ro | Ảnh hưởng | Giảm thiểu |
|---|---|---|---|
| R1 | Free tier giới hạn số kết nối → hết slot | Cao | Pool tối đa 3/tenant, idle eviction 5 phút, dùng pooler của Supabase |
| R2 | Mất `INFRA_MASTER_ENCRYPTION_KEY` | Nghiêm trọng — không giải mã lại được | Sao lưu khoá ngoài repo (password manager), cột `encryption_key_version` sẵn cho rotation |
| R3 | Neon/Supabase tự ngủ đông (cold start) | Trung bình | Health check định kỳ, timeout 10s, hiển thị `degraded` thay vì lỗi |
| R4 | API key `pk_live_` lọt vào bundle client | Cao | Tài liệu SDK ghi rõ "server-only"; kiểm tra origin; scope tối thiểu |
| R5 | Better Auth thay đổi API giữa các version | Trung bình | Pin version chính xác, cô lập trong `packages/auth` |
| R6 | Turso/LibSQL khác biệt phương ngữ SQL với PG | Trung bình | Adapter khai báo `dialect`; SDK không hứa hẹn SQL đa phương ngữ |
| R7 | Thư mục kết nối bị gắn lại → mất file chưa commit | Cao (đã xảy ra 1 lần) | Commit git sớm và thường xuyên; giữ bản sao tài liệu trong phiên trước khi ghi xuống máy |
