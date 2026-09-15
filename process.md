# process.md — Unified-App-Infra · Living State Machine

| Field | Value |
|---|---|
| Current version | **v0.9.2** |
| Current phase | **G1 đang đóng** — hai hàm chưa từng chạy được đã sửa, xoay khoá đã diễn tập thật |
| Phase status | `LIVE` — Master DB đã chạy thật trên Neon, định tuyến đa nhà cung cấp đã kiểm chứng 2/2 |
| Last build | `PASS` — 6/6 packages (turbo 2.10.12) |
| Last test | `PASS` — 39 test files, **536 tests** (core 383 · sdk 51 · adapters 50 · web 31 · db 21) |
| Next task | **G1 còn lại** — mail thật cho production (cần Khoi chọn nhà cung cấp), diễn tập restore trên Neon branch, Turso |

> **File này là gì (VN):** đây là *nhật ký sống* của dự án. `tech.md` trả lời "hệ thống được
> thiết kế thế nào", còn `process.md` trả lời "hiện đang làm tới đâu, việc tiếp theo là gì".
> Mỗi lần hoàn thành một việc, ghi thêm **một entry ở trên cùng** mục Active Worklog.

---

## 1. Operating Protocol

**Mỗi phiên làm việc:**

```
1. Pre-Flight Anchor Check   → đọc tech.md, rồi process.md. KHÔNG quét đệ quy workspace.
2. Xác định Next Task        → lấy từ entry trên cùng của Active Worklog (§5).
3. Thực thi                  → chỉ làm đúng task đó.
4. Verify                    → pnpm build && pnpm test   (cả hai phải PASS)
5. Persist                   → ghi entry mới lên ĐẦU Active Worklog theo template §5.0
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

### Phase 1 — Foundation, Security & Master DB Setup  `DONE` ✅
- [x] **T1.1** Khởi tạo monorepo (pnpm workspaces + Turborepo + `tsconfig.base.json` strict)
- [x] **T1.2** `packages/core`: `crypto.ts` (AES-256-GCM encrypt/decrypt + AAD + key version)
- [x] **T1.3** `packages/core`: `api-key.ts` (sinh `pk_live_…`, hash SHA-256, tách prefix)
- [x] **T1.4** `packages/core`: `env.ts` (zod), `errors.ts` (InfraError taxonomy)
- [x] **T1.5** Vitest cho `core` — crypto round-trip, sai AAD/authTag phải fail, format khoá
- [x] **T1.6** `packages/db`: schema Drizzle 4 bảng `infra_*` + bảng Better Auth + `infra_app_members`
- [x] **T1.7** Chạy migration `0000` lên Neon Master DB ✅ **applied successfully** (2026-09-12)
- [x] **T1.8** `packages/db/src/queries/` — truy vấn có kiểu cho apps / keys / configs / audit
- [x] **G1** ✅ Gate đã đóng — Phase 1 hoàn tất

### Phase 2 — Centralized Auth Hub  `DONE` ✅
- [x] **T2.1** `packages/auth`: khởi tạo Better Auth + Drizzle adapter trên Master DB
- [x] **T2.2** Email/Password (tối thiểu 12 ký tự, bắt xác minh email khi production)
- [x] **T2.3** OAuth Google · GitHub · Microsoft — chỉ bật provider nào có đủ cặp id/secret
- [x] **T2.4** `app-scope.plugin.ts` + bảng `infra_app_members` + `session.active_app_id`
- [x] **T2.5** Route handler `apps/web/src/app/api/auth/[...all]/route.ts` (khởi tạo lazy)
- [x] **T2.6** `trustedOrigins` động đọc từ `infra_apps.allowed_origins`
- [x] **T2.7** Test cách ly user giữa các app ✅ — bộ adversarial `cross-app` + live-proof 2026-09-14

### Phase 3 — Dynamic Multi-DB Adapter  `DONE` ✅ *(LibSQL: có test, chưa chạm DB thật — G1-6)*
- [x] **T3.1** `packages/adapters`: interface `DatabaseAdapter` + `types.ts`
- [x] **T3.2** `postgres.adapter.ts` (Neon + Supabase qua `postgres-js`, `prepare: false` cho pooler)
- [x] **T3.3** `libsql.adapter.ts` (Turso qua `@libsql/client`, tách authToken khỏi DSN)
- [x] **T3.4** `resolver.ts` — appId → adapter, giải mã đúng lúc cần, gộp các miss đồng thời
- [x] **T3.5** `pool.ts` — LRU 25 + TTL 5 phút + đóng adapter khi evict
- [x] **T3.6** `health.ts` — ping, phân loại latency, `worstStatus`, kiểm tra nhiều app song song
- [x] **T3.7** `apiKeyGuard` + route `POST /api/v1/query`, `GET /api/v1/health`, `GET /api/v1/me`
- [x] **T3.8** Ghi `infra_audit_logs` bất đồng bộ (fire-and-forget, không chặn response)
- [x] **T3.9** Vitest cho adapters + resolver (driver giả lập) — 30 test
- [x] **G3** ✅ Gate đã đóng

### Phase 4 — Admin Dashboard & Client SDK  `DONE` ✅
- [x] **T4.1** `apps/web`: Next.js **16.3.4** App Router + Tailwind v4 + Shadcn UI + Lucide (ADR-008)
- [x] **T4.2** Sign-in / sign-up cho admin (email + 3 nút OAuth) + guard layout dashboard
- [x] **T4.3** CRUD app bằng Server Actions: tạo, sửa origin, đình chỉ, lưu trữ
- [x] **T4.4** Quản lý API key: cấp (hiện raw đúng một lần, có nút copy), xoay vòng, thu hồi
- [x] **T4.5** Quản lý database config: chọn provider, dán DSN → mã hoá ngay, huỷ cache resolver
- [x] **T4.6** Trang Health monitoring (badge, latency, nút kiểm tra thủ công)
- [x] **T4.7** Viewer `infra_audit_logs`
- [x] **T4.8** `packages/sdk`: `createInfraClient()` + auth + db + kiểu `Result`
- [x] **T4.9** `README.md` quickstart "dưới 10 dòng"
- [x] **G4** ✅ Đã chạy thật với Neon (2026-09-14) và tích hợp child app `examples/notes-app` (T8.7)

### Phase 5 — Identity Plane (Auth Core)  `DONE` ✅  ← giai đoạn 1 của Khoi
> Thiết kế đầy đủ ở `docs/iam-blueprint.md`. Đây là phase lớn nhất; ba phase sau đứng lên nó.
- [x] **T5.1** `infra_signing_keys` + JWKS endpoint + ký ES256, xoay khoá 90 ngày ✅
- [x] **T5.2** Access token (JWT 10 phút, claims `aud`=app_id / `sid` / `act` / `amr`) ✅
- [x] **T5.3** `infra_refresh_tokens` + xoay vòng + **phát hiện tái sử dụng** (thu hồi cả family) ✅
- [x] **T5.4** `/api/v1/auth/{token,refresh,revoke}` + CORS động theo `allowed_origins` ✅
- [x] **T5.5** Đổi `/api/v1/me` từ cookie sang Bearer token (§4.3 blueprint) ✅
- [x] **T5.6** **Tách `pk_` / `sk_`** — thêm `key_type`, chặn `sk_` gọi từ trình duyệt (§4.1) ✅
- [x] **T5.7** `infra_platform_admins` + allowlist email + MFA bắt buộc cho super admin ✅
- [x] **T5.8** MFA: TOTP + backup codes + `infra_mfa_factors` (nhiều yếu tố/user) ✅
- [x] **T5.9** Passkey/WebAuthn: đăng ký + đăng nhập + chống clone theo signature counter ✅
- [x] **T5.10** Step-up auth + `infra_trusted_devices` (ghi nhớ trình duyệt 30 ngày) ✅
- [x] **T5.11** Session & device management: trang /security/sessions ✅ (thu hồi từng phiên: T8)
- [x] **T5.12** RBAC: `infra_roles`, `infra_role_assignments`, catalog permission, khớp wildcard ✅
- [x] **T5.13** ABAC: `infra_policies` + engine + deny thắng allow + mặc định từ chối ✅
- [x] **T5.14** `checkAccess()` + decision log vào `infra_audit_logs` ✅
- [x] **T5.15** Workspace schema (`infra_workspaces`, `infra_workspace_members`, `workspace_id` NULLABLE) ✅
- [x] **T5.16** Vòng đời user: mời, chuyển, vô hiệu hoá, offboard (thu hồi mọi token), soft delete + purge ✅
- [x] **T5.17** `infra_service_accounts` + grant `client_credentials` + IP allowlist ✅
- [x] **T5.18** Chống dò mật khẩu, kiểm mật khẩu đã lộ (HIBP k-anonymity), luồng khôi phục tài khoản ✅
- [x] **T5.19** Webhook sự kiện identity cho app con ✅
- [x] **T5.20** Test: cách ly chéo app, tái sử dụng refresh token, leo thang quyền, mặc định từ chối ✅
- [x] **G5** ✅ Gate đã đóng — bump **v0.4.0**

### Phase 6 — Auto-provisioning & Delegation  `DONE`  ← giai đoạn 2
- [x] **T6.1** Neon API: tự tạo project/branch khi tạo app mới ✅
- [x] **T6.2** Turso API: tự tạo database + token ✅
- [x] **T6.3** Tự mã hoá DSN vừa tạo, tự dọn khi xoá app ✅
- [x] **T6.4** Theo dõi hạn mức free tier từng nhà cung cấp ✅
- [x] **T6.5** Impersonation có lý do + hạn giờ + banner + audit (`infra_impersonation_sessions`) ✅
- [x] **G6** Gate → bump **v0.5.0** ✅

### Phase 7 — Data API Gateway & Security Rules  `DONE`  ← giai đoạn 3
- [x] **T7.1** Query DSL có kiểu (`from().select().eq().order().limit()`) ✅
- [x] **T7.2** Biên dịch DSL → SQL tham số hoá cho Postgres và LibSQL ✅
- [x] **T7.3** Áp policy: server chèn điều kiện, client chỉ thu hẹp được ✅
- [x] **T7.4** `POST /api/v1/data/:resource` (pk_ + Bearer) tách khỏi `/api/v1/query` (sk_ only) ✅
- [x] **T7.5** Decision log + đo hiệu năng overhead của rules ✅
- [x] **T7.6** Test: cố tình vượt rào rules, SQL injection qua DSL, nới rộng filter ✅
- [x] **G7** Gate → bump **v0.6.0** ✅

### Phase 8 — SDK v2 & Dashboard hoàn chỉnh  `DONE`  ← giai đoạn 4
- [x] **T8.1** `createServerClient()` cho BFF (token nằm ở server app con) ✅
- [x] **T8.2** Tự refresh token + hàng đợi request khi token hết hạn ✅
- [x] **T8.3** `infra.from(...)` query builder phía client ✅
- [x] **T8.4** UI: quản lý role/permission/policy ✅
- [x] **T8.5** UI: MFA, passkey, danh sách thiết bị & phiên ✅
- [x] **T8.6** UI: service account, workspace ✅
- [x] **T8.7** Tích hợp thật một app con (AI Study OS) làm bằng chứng dưới 10 dòng ✅
- [x] **G8** ✅ Tám phase đã xong. **v1.0.0 vẫn chưa phát hành** — còn G1 ở §4 (mail production, diễn tập backup/xoay khoá, cron).

---

## 3. Next Task — chi tiết

> **G1 — những việc còn lại trước khi phát hành v1.0.** Tám phase đã xong và hệ thống đã chạy
> thật (xem §4). Bốn việc còn lại đều cần Khoi quyết định hoặc cần chạy trên máy thật, không
> phải viết thêm code.

**G1-a · Mail thật cho production** *(chặn v1.0)*
1. Chọn nhà cung cấp: `resend` (một lệnh gọi HTTPS, không cần SDK) hoặc `webhook` (tự relay qua SMTP).
2. Đặt vào `.env.local` khi deploy — **không dán vào chat**:
   `INFRA_MAIL_PROVIDER`, `INFRA_MAIL_API_KEY`, `INFRA_MAIL_FROM`.
3. Thử: gọi luồng quên mật khẩu, xác nhận thư tới hộp thật.
> `console` đang đặt sẵn chỉ dùng được ở dev — nó in link ra terminal, không ai nhận được thư.

**G1-b · Diễn tập backup / restore** — `docs/runbooks.md` §3.
Backup chưa thử khôi phục thì chưa phải backup. Tạo một Neon branch, restore vào đó, chạy
`pnpm verify:live` trỏ vào branch ấy, xác nhận đủ 31 bảng.

**G1-c · Diễn tập xoay `INFRA_MASTER_ENCRYPTION_KEY`** — `docs/runbooks.md` §2.
Quy trình lẫn bài diễn tập đã viết sẵn. Thiếu đúng một thứ: chạy nó một lần trên branch.

**G1-d · Cài lịch cron** — `docs/runbooks.md` §1.
`INFRA_INTERNAL_TOKEN` đã có trong `.env.local`. Còn lại là một dòng crontab (self-host) hoặc
`vercel.json` (Vercel) gọi `POST /api/internal/maintenance` mỗi giờ.

**Không chặn:** G1-6 (Turso chưa cấu hình lần nào — smoke test đa nhà cung cấp mới 2/3).

---

## 4. v1.0 Readiness — khoảng cách thật giữa "xong 8 phase" và "chạy được thật"

> Tám phase đã xong không có nghĩa là sẵn sàng production. Mục này liệt kê **đúng những gì còn
> thiếu**, xếp theo mức chặn. Viết ra để không ai — kể cả mình ở phiên sau — nhầm "test xanh" với
> "chạy được".

### Chặn v1.0 (phải làm)

| # | Khoảng cách | Vì sao chặn | Ai làm được |
|---|---|---|---|
| ~~**G0-1**~~ | ~~Migration chưa apply~~ ✅ | **Kiểm chứng 2026-09-14** bằng `pnpm verify:live`: 31 bảng, 12 migration đã ghi nhận. Log ở `logs/verify-2026-09-14T05-52-52-018Z.log`. | xong |
| **G0-2** | **Dev: xong. Production: chưa.** | `INFRA_MAIL_PROVIDER=console` đã đặt 2026-09-14 → luồng khôi phục chạy được ở dev. **Production vẫn cần một nhà cung cấp thật** (`resend` hoặc `webhook`) — `console` chỉ in ra log, không ai nhận được thư. | Khoi: chọn nhà cung cấp khi deploy |
| ~~**G0-3**~~ | ~~Rate limit trong bộ nhớ tiến trình~~ ✅ | `infra_rate_limits` là bộ đếm dùng chung, một upsert mỗi lượt kiểm; lớp trong bộ nhớ **chỉ được từ chối, không được cho qua** (ADR-025). **Đóng ở v0.7.3 là quá sớm**: câu upsert ném lỗi mọi lần chạy và vì fail-open nên không ai thấy. Sửa + kiểm chứng trên Postgres thật ở v0.9.1. | xong |
| ~~**G0-4**~~ | ~~Chưa chạy thật lần nào~~ ✅ | **2026-09-14: 11/11 phán quyết đúng trên Master DB thật + database Neon thật.** Log ở `logs/live-proof-2026-09-14T06-19-45-519Z.log`. | xong |

### Nên làm trước khi có người dùng thật

| # | Khoảng cách | Ghi chú |
|---|---|---|
| G1-1 | Backup/restore Master DB: đã có runbook, **chưa bật và chưa thử** | `docs/runbooks.md` §3. Cách kiểm giờ là một lệnh: `INFRA_MASTER_DATABASE_URL="<dsn branch>" pnpm verify:live` — phải ra 31 bảng, 12 migration. Vẫn cần Khoi bật PITR và tạo branch. Backup chưa thử khôi phục thì chưa phải backup. |
| ~~G1-2~~ | ~~Xoay khoá: có runbook, chưa diễn tập~~ ✅ | **Đã diễn tập 2026-09-14** trên Postgres 16 với schema thật (31 bảng), 9 dòng ciphertext / 4 bảng, xoay 1→2→3, idempotent. Bài diễn tập bắt được một lỗi thật trong công cụ. Runbook cũ **sẽ làm mất dữ liệu** nếu làm theo — đã viết lại (ADR-027/028/029). Công cụ: `scripts/rotate-master-key.mjs`. |
| G1-3 | Lịch chạy: token đã đặt, **có công cụ cài**, chưa cài trên máy đích | `vercel.json` khai báo sẵn hai cron (deploy Vercel là có). Tự host: `./scripts/install-cron.sh`, idempotent, token nằm ở file quyền 600 chứ không nhúng vào crontab. Hai endpoint **đã gọi thử thật** và đã sửa hai lỗi tìm ra khi gọi (v0.9.1). |
| ~~G1-4~~ | ~~Job dọn chưa có lịch~~ ✅ | Gom vào `POST /api/internal/maintenance`, chạy mỗi giờ. |
| ~~G1-5~~ | ~~Chưa có CI~~ ✅ | `.github/workflows/ci.yml`: install → build → test → typecheck → **kiểm migration drift**. Không cần secret nào. |
| G1-6 | Turso chưa cấu hình lần nào — **nhưng nhánh LibSQL đã chạy thật** | `packages/adapters/tests/libsql-live.test.ts` chạy SQL do compiler sinh ra trên một database LibSQL thật (`@libsql/client` mở file cục bộ — cùng client, cùng đường mã, chỉ khác chỗ lưu). Đã kiểm: placeholder `?` chứ không phải `$n`, cách ly theo chủ sở hữu, filter client không nới rộng được, thứ tự tham số khi ba nguồn nối vào một câu. **Còn lại thuộc về Turso chứ không thuộc LibSQL**: authToken, TLS, độ trễ mạng, replica. |

### Rủi ro đã biết và chấp nhận

| # | Rủi ro | Vì sao chấp nhận |
|---|---|---|
| A-1 | DNS rebinding vào webhook (R10) | `isPublicHttpUrl` kiểm trên URL và **chặn redirect**. Muốn kín hơn thì egress qua proxy ghim IP đã resolve — chưa cần ở quy mô hiện tại. |
| A-2 | HIBP fail open (R9, ADR-020) | Có chủ đích. Đổi lại: sự cố bên thứ ba không khoá được luồng đăng ký. |
| A-3 | Quota check fail open khi chưa có số liệu | Có chủ đích. Nhà cung cấp tự từ chối khi vượt hạn mức; check này chỉ để báo lỗi sớm và đẹp hơn. |
| A-4 | Chưa có SAML/SCIM (ADR-015) | Quyết định của Khoi, chưa có khách hàng doanh nghiệp. |
| A-5 | Không có đọc ẩn danh (ADR-024) | Có chủ đích. Bật nó phải là hành động có ý thức, và cơ chế chưa tồn tại. |

---

## 5. Active Worklog  *(mới nhất ở trên cùng)*

### 5.0 Template — copy khối này lên đầu §5 cho mỗi lần hoàn thành task

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

### 2026-09-14 · v0.9.2 · test(adapters): nhánh LibSQL lần đầu chạy trên LibSQL thật

Cùng một lý lẽ với v0.9.1, áp sang phương ngữ còn lại. Compiler sinh SQL cho hai phương ngữ.
Postgres đã chạy thật (live-proof trên Neon). LibSQL thì chưa bao giờ — và lý do vẫn được ghi là
"chưa có tài khoản Turso".

Nhưng Turso là LibSQL có hosting. `@libsql/client` mở database cục bộ bằng `file:`, **cùng client,
cùng đường mã**. Nên phần lớn rủi ro của G1-6 đóng được ngay, không cần tài khoản nào.

**Deliverables**
- `packages/adapters/tests/libsql-live.test.ts` (new, 5 test) — đi đúng đường của
  `/api/v1/data/:resource`: parse → quyết định → biên dịch → thực thi, chỉ khác đầu kia là LibSQL.
  Kiểm: placeholder `?` chứ không phải `$n` (một câu SQL Postgres lọt sang sẽ hỏng đúng ở đây, và
  trên driver giả thì không), cách ly theo chủ sở hữu, filter của client **thu hẹp được chứ không
  nới rộng được**, thứ tự tham số khi filter + policy + limit nối vào cùng một câu, và tài nguyên
  không có policy biên dịch thành `1 = 0`.

**Test status** — `pnpm build` PASS · `pnpm typecheck` PASS · `pnpm test` PASS (**536 passed**)

**Notes** — G1-6 thu hẹp lại đúng phần còn thật sự chưa kiểm được: authToken, TLS, độ trễ mạng và
hành vi replica. Đó là phần thuộc về Turso, và cần Khoi mở tài khoản. Phần thuộc về LibSQL thì xong.

**Next task** → G1 còn lại: mail thật cho production, diễn tập restore trên Neon branch, Turso.

### 2026-09-14 · v0.9.1 · fix(db): hai hàm chưa từng chạy được lần nào, trong khi 518 test đều xanh

**Tìm ra thế nào**

Trước khi bảo Khoi cài cron, gọi thử hai endpoint mà cron sẽ gọi — trên Postgres 16 cục bộ, bằng
`curl`, đúng cách cron sẽ gọi. Lần đầu tiên hai endpoint đó được gọi thật.

```
{"job":"login_attempts","ok":true}  {"job":"impersonations","ok":false,"detail":"Error"}
```

HTTP **200**.

**Lỗi 1 — `Date` trong template `sql` thô tới Postgres dưới dạng không parse được**

Một `Date` nội suy vào template `sql` đi thẳng tới driver, **không qua type mapper của cột**, nên
tới nơi dưới dạng `Mon Sep 14 2026 06:39:44 GMT+0000 (Coordinated Universal Time)`. Postgres không
parse được thành `timestamptz`. Câu lệnh ném lỗi **mọi lần chạy**. Ba chỗ dính:

| Hàm | Hậu quả thật |
|---|---|
| `expireImpersonations` | Phiên mạo danh hết giờ **không bao giờ bị đóng** — đúng thứ mà chính docstring của endpoint cảnh báo |
| `consumeShared` | **Bộ đếm rate limit dùng chung chưa từng ghi được một dòng nào** |
| `findValidRecoveryToken` (security.ts) | Cùng lỗi, trên đường khôi phục tài khoản |

`consumeShared` là nghiêm trọng nhất, vì nó **fail open** theo thiết kế: tầng gọi bắt lỗi và cho
qua. Nên trên production nó trông y hệt như đang hoạt động — không log lỗi, không request nào bị
chặn sai, hạn mức âm thầm tụt về lớp trong bộ nhớ của từng instance. Đúng loại lỗi mà chính header
của `rate-limit.ts` gọi tên: *"the worst kind of security bug: one that looks like it is working"*.
**G0-3 từng được đánh dấu đóng ở v0.7.3 là sai** — code đã viết đúng ý tưởng nhưng chưa từng chạy.

Sửa: dùng `lte`/`gt` của drizzle (có type mapper) thay cho template; chỗ buộc phải dùng template
(`case when` trong upsert) thì truyền chuỗi ISO và ép kiểu `::timestamptz` tường minh.

**Lỗi 2 — job hỏng mà HTTP vẫn 200**

Runbook dặn cron gọi bằng `curl -fsS` để một lần hỏng thành mã thoát khác 0. Endpoint trả 200 kèm
`ok:false` trong body làm kiểm tra đó vô nghĩa: curl vui vẻ, cron im lặng, và một job hỏng mỗi giờ
suốt nhiều tháng là vô hình. Nay bất kỳ job nào hỏng → **HTTP 500**, body vẫn liệt kê đủ từng job
nên biết *job nào* chứ không chỉ "có gì đó hỏng". Kiểm chứng: đổi tên bảng cho job hỏng →
`curl -f` thoát mã 22.

**Lỗi 3 — vì sao 518 test không bắt được, và hàng rào để nó không lặp lại**

Không có test nào chạm Postgres thật. Cả bộ test chạy trên fake/mock, và một driver giả không bao
giờ từ chối một tham số sai kiểu.

- `packages/db/tests/integration.test.ts` — bỏ qua khi không có `INFRA_TEST_DATABASE_URL`, nên
  `pnpm test` trên máy trống vẫn xanh, nhưng **hiện ra là "skipped"** chứ không biến mất, để không
  ai nhầm "không chạy" với "đã chạy và xanh". Kiểm chứng ngược: hoàn nguyên bản sửa → 4/5 test đỏ.
- `.github/workflows/ci.yml` — thêm service `postgres:16` + health check, apply migration 0000→0011
  lên đó (tự nó cũng là một kiểm tra: migration phải apply sạch từ rỗng), rồi chạy test. Vẫn không
  cần secret nào.
- `turbo.json` — thêm `INFRA_TEST_DATABASE_URL` vào `env` của task `test`. Thiếu dòng này turbo
  lọc mất biến và test tích hợp **tự bỏ qua trong im lặng ngay cả trên CI** — suýt nữa thì hàng rào
  vừa dựng đã vô hiệu.
- `apps/web/src/lib/job-report.ts` + test — bất biến một câu: *job nào hỏng thì status phải khác 2xx*.

**Modified files**
- `packages/db/src/queries/rate-limits.ts` · `impersonation.ts` · `security.ts` (edit)
- `packages/db/tests/integration.test.ts` (new) · `apps/web/src/lib/job-report.ts` (new)
- `apps/web/src/app/api/internal/maintenance/route.ts` · `apps/web/tests/api.test.ts` (edit)
- `.github/workflows/ci.yml` · `turbo.json` (edit)

**Test status**
- `pnpm build` → PASS (6/6) · `pnpm typecheck` → PASS
- `pnpm test` → PASS (**531 passed**: core 383 · sdk 51 · adapters 45 · web 31 · db 21)
- Endpoint kiểm chứng thật trên Postgres cục bộ: 401 khi thiếu token · 401 khi sai token ·
  200 khi cả bốn job xanh · 500 khi một job hỏng · `curl -f` thoát mã 22.

**Notes / decisions**
- ADR-030.
- Bài học lặp lại lần thứ hai trong dự án: **test xanh không phải là đã chạy.** Lần trước là
  migration, lần này là bốn câu SQL. Cả hai lần, thứ phát hiện ra là chạy thật một lần.

**Next task** → G1 còn lại: mail thật cho production, diễn tập restore trên Neon branch, Turso.


### 2026-09-14 · v0.9.0 · fix(crypto): xoay khoá — quy trình đã viết ra nhưng không chạy được

**Vấn đề tìm thấy khi đi đóng G1-2**

Runbook §2 bảo: đặt khoá mới, chạy `scripts/rotate-encryption-key.py`, health check. Làm theo
đúng như vậy sẽ **mất toàn bộ dữ liệu mã hoá**. Bốn lỗi chồng lên nhau:

1. **Công cụ không làm việc mà runbook nói.** `rotate-encryption-key.py` chỉ thay một dòng trong
   `.env.local`. Nó không đọc database, không mã hoá lại gì cả. Docstring của nó *hứa* rằng
   "script từ chối chạy khi đã có dòng mã hoá" — trong mã không hề có kiểm tra đó. Nó ghi đè vô
   điều kiện.
2. **Runbook dặn tráo hai khoá cho nhau** — khoá mới vào `INFRA_MASTER_ENCRYPTION_KEY`, khoá cũ
   vào `_V1`. Nhưng `masterKeyEnvVar(1)` trả về biến trần, nên mọi dòng đang ở phiên bản 1 sẽ đi
   tìm khoá cũ ở đúng chỗ vừa bị đặt khoá mới vào. Hỏng sạch ngay lập tức.
3. **`CURRENT_KEY_VERSION` là hằng số**, nên vòng xoay không bao giờ kết thúc được: dòng mới ghi
   sau đó vẫn dùng khoá phiên bản 1 — khoá vừa định loại bỏ (ADR-027).
4. **Runbook chỉ kiểm một trong bốn bảng.** Health check app chỉ chạm `infra_database_configs`.
   `infra_signing_keys`, `infra_webhook_endpoints`, `infra_mfa_factors` hỏng âm thầm cho tới lần
   đăng nhập / lần webhook / lần nhập mã MFA tiếp theo (ADR-029).

**Deliverables**
- `scripts/rotate-master-key.mjs` — mã hoá lại thật, cả bốn bảng, giữ nguyên AAD, `--dry-run`,
  chạy lại được (bỏ qua dòng đã ở phiên bản đích), `WHERE encryption_key_version = <cũ>` để hai
  lần chạy song song không đè nhau. Không in DSN, khoá, seed hay secret.
- `scripts/drill-seed.mjs` + `scripts/drill-verify.mjs` — bài diễn tập, từ chối chạy nếu DSN không
  phải localhost và không chứa chữ `drill`. `drill-verify` **không tin** báo cáo của công cụ xoay:
  nó mở lại từng dòng bằng khoá mới *và* xác nhận khoá cũ không còn mở được dòng nào.
- `packages/core/src/crypto.ts` — `currentKeyVersion()` đọc `INFRA_MASTER_ENCRYPTION_KEY_VERSION`
  (mặc định 1); `masterKeyEnvVar` thành ánh xạ cố định (ADR-028); `assertMasterKey` kiểm khoá của
  phiên bản sẽ **ghi**, không phải phiên bản 1.
- `scripts/rotate-encryption-key.py` — giữ lại làm công cụ đặt khoá **lần đầu**, và giờ thật sự
  từ chối ghi đè một khoá hợp lệ, kèm hướng dẫn sang công cụ đúng.
- `vercel.json` + `scripts/install-cron.sh` — G1-3 thành file thật thay vì đoạn văn trong runbook.
  Installer idempotent, và **không nhúng token vào crontab**: token nằm ở
  `~/.config/unified-app-infra/internal-token` quyền 600, dòng cron `cat` ra khi chạy.
- `docs/runbooks.md` §1 §2 §3 viết lại theo những gì công cụ thật sự làm.

**BÀI DIỄN TẬP ĐÃ CHẠY** — đây mới là phần đáng kể

Postgres 16 cục bộ, schema thật qua `pnpm db:migrate` (**31 bảng**, khớp đúng Neon), 9 dòng
ciphertext trên cả bốn bảng, một factor WebAuthn không có seed để xác nhận cột null bị bỏ qua
chứ không bị coi là hỏng.

```
xoay 1→2:   9/9 dòng, khoá cũ không mở được dòng nào
chạy lại:   0 dòng cần xoay  (idempotent)
xoay 2→3:   9/9 dòng          (chuỗi phiên bản)
```

**Bài diễn tập bắt được một lỗi thật trong chính công cụ.** Lần `--dry-run` đầu tiên báo
`infra_signing_keys: FAIL 2/2`. Nguyên nhân: câu select đặt bí danh `kid as id` cho mọi bảng, còn
AAD của signing key lại dựng từ `row.kid` → `signing-key:undefined`. Nếu chạy thẳng vào Master DB
thật thay vì diễn tập trước, hai khoá ký sẽ mất, và triệu chứng là **mọi đăng nhập chết** — cách
xa nguyên nhân đủ để mất vài giờ. Đây chính xác là lý do diễn tập tồn tại.

**Test status**
- `pnpm build` → PASS (6/6 packages)
- `pnpm test` → PASS (**523 passed**, +5 — trong đó có test khẳng định `masterKeyEnvVar(1)` không
  đổi nghĩa khi phiên bản hiện tại tăng, và test khẳng định phiên bản rác bị từ chối chứ không
  âm thầm rơi về 1)
- `pnpm typecheck` → PASS · `pnpm db:generate` → không có drift

**Notes / decisions**
- ADR-027, ADR-028, ADR-029.
- G1-2 **đóng**: quy trình đã chạy thật một lần, trên schema thật, và đã sửa lỗi nó tìm ra.
- G1-3 chuyển từ "chưa cài" sang "có một lệnh để cài" — cài thật vẫn cần chạy trên máy đích.
- `pnpm verify:live` nay là cách kiểm bài diễn tập restore: biến môi trường thắng `.env.local`,
  nên `INFRA_MASTER_DATABASE_URL="<dsn branch>" pnpm verify:live` chạy thẳng vào branch.

**Next task** → G1 còn lại: mail thật cho production (cần Khoi chọn nhà cung cấp), diễn tập
restore trên Neon branch, Turso.


### 2026-09-14 · v0.8.0 · feat(proof): the platform actually works — live end-to-end evidence

**🟢 G0 đóng hết. Đây là lúc dự án thôi là "test xanh" và thành "chạy được thật".**

**Bằng chứng LIVE — `scripts/live-proof.mjs`, 11/11 phán quyết đúng**
Chạy đúng đường mà `/api/v1/data/:resource` chạy — parse → quyết định → biên dịch → thực thi —
nhưng đầu kia là **Master DB thật và database Neon của app con thật**, không phải adapter giả.
Nó nạp `packages/core/dist` chứ không chép lại logic: nếu một hàm nào đó khác với hàm endpoint
dùng thì bằng chứng này vô giá trị.

```
app: smoke-neon · provider neon
DSN: giải mã OK (AES-256-GCM, AAD buộc theo dòng) — không in ra
bảng live_proof_notes: 3 dòng (alice 2, bob 1) · policy: 4 bản ghi
OK  alice thấy 2 dòng · bob thấy 1 dòng
    câu lệnh alice: select "id","title" from "live_proof_notes" where (("owner_id" = $1)) limit $2
OK  bob đòi dòng của alice: 0
OK  người lạ: 0
OK  tài nguyên không có policy → 1 = 0
OK  bob chèn dòng mang tên alice: bị từ chối
OK  bob chèn dòng bỏ trống owner_id: undecidable → fail closed
OK  bob sửa dòng của alice: 0 dòng bị đổi
```

Dòng đáng nhìn nhất là câu lệnh của alice: **nó không hề nhắc tới `owner_id`**. Điều kiện đó do
server AND vào. Đó chính là tính chất khiến khoá `pk_` an toàn khi nằm trong bundle trình duyệt, và
giờ nó đã được chứng minh trên dữ liệu thật chứ không chỉ trong test.

**Hai biến môi trường đã đặt**
- `INFRA_MAIL_PROVIDER=console` — luồng khôi phục chạy được ở dev. **Production vẫn cần nhà cung
  cấp thật**; `console` chỉ in ra log.
- `INFRA_INTERNAL_TOKEN` — sinh ngẫu nhiên 288 bit. Hai endpoint theo lịch thôi từ chối mọi lời gọi.
- `.env.local` đã sao lưu thành `.env.local.bak-<timestamp>` trước khi sửa.

**🔴 Một giả định sai suốt nhiều phiên, nay đã sửa**
Suốt từ đầu dự án mình ghi là "egress tới Neon bị chặn ở cả hai phía". **Sai.** VM Linux nối tới máy
Khoi **với tới cổng database của Neon bình thường** — chỉ `console.neon.tech` (API quản trị qua
HTTPS) mới bị chặn. Vì tin vào giả định đó nên nhiều việc lẽ ra làm được đã bị đẩy sang cho Khoi.
Bài học: **kiểm tra một lần còn hơn mang một giả định đi suốt.**

**Chi tiết kỹ thuật của script**
- Viết `.mjs` chứ không `.mts`: `node_modules` trên mount là bản **darwin**, mà VM là **Linux**.
  `tsx` kéo theo `esbuild` là binary gốc nên không chạy; `postgres-js` và các `dist/` của dự án là
  JavaScript thuần nên chạy bình thường.
- Đường dẫn `postgres` được **dò** chứ không ghi cứng version — một lần `pnpm up` là số đó đổi.
- Lần chạy đầu **treo hết 180 giây**: Neon ngủ đông. Lần hai chạy **1,3 giây**. Và mình đã lặp lại
  đúng lỗi cũ của phiên đầu — `| tail` giữ toàn bộ output tới khi tiến trình kết thúc, nên treo ở
  đâu cũng không nhìn thấy. Phải ghi thẳng ra file.

**Modified files**
- `scripts/live-proof.mjs` (new) · `.env.local` (edit, đã sao lưu)

**Test status**
- `pnpm build` → PASS (6/6) · `pnpm test` → PASS (518/518)
- **LIVE: 11/11 phán quyết đúng trên Neon thật.**

**Notes / decisions**
- Bài chứng minh chạy trên app `smoke-neon` sẵn có, dùng bảng riêng `live_proof_notes` để không
  chạm vào thứ gì khác. `node scripts/live-proof.mjs --cleanup` xoá sạch bảng và 4 policy đó.
- Giữ lại dữ liệu chứng minh sau lần chạy này, để Khoi mở Dashboard `/apps/<id>/access` là **nhìn
  thấy policy thật và mảnh SQL nó biên dịch ra** thay vì phải tin lời kể.

**Next task** → G1: nhà cung cấp mail thật khi deploy · diễn tập backup và xoay khoá · cài cron.

### 2026-09-14 · v0.7.4 · chore(ops): verify-live, và bằng chứng LIVE đầu tiên của dự án

**Deliverables**
- `scripts/verify-live.mts` + `pnpm verify:live` — tồn tại vì **hai bên không nhìn thấy cùng một
  thứ**: egress tới Neon bị chặn phía Claude, nên câu "đã chạy xong" không kiểm chứng được từ xa.
  Script chạy ở máy Khoi và ghi log; **log là bằng chứng, không phải lời kể.**
- Log **che dữ liệu nhạy cảm** theo đúng quy tắc của dự án: chỉ tên bảng, số đếm, số migration.
  Không connection string, không khoá, không email, không giá trị của bất kỳ dòng nào.
- `packages/db/src/queries/inspect.ts` — SQL thô chuyển vào đây **vì ADR-009**: mọi truy vấn Drizzle
  sống trong `@infra/db`. Bản đầu của script import thẳng `drizzle-orm` từ gốc repo và **vỡ ngay**
  (`ERR_MODULE_NOT_FOUND` — gói đó không phải dependency của gốc). Mình đã viết ra luật rồi tự phá nó.

**🟢 Kết quả kiểm chứng — 2026-09-14T05:52Z**
```
tables: 31 có mặt, kỳ vọng tối thiểu 31
OK    đủ toàn bộ bảng — migration 0000→0011 đã apply
migrations đã ghi nhận: 12
infra_apps: 2 · infra_api_keys: 4 · infra_database_configs: 4 · infra_policies: 0
mail: CHƯA cấu hình
INFRA_INTERNAL_TOKEN: CHƯA đặt
```

**Phát hiện quan trọng hơn cả con số bảng: `infra_policies: 0`**
Đã có 2 app và 4 database config, nhưng **không có policy nào**. Nghĩa là mọi request qua
`/api/v1/data` đang bị từ chối sạch. Đây **không phải lỗi** — đó là mặc định từ chối đang chạy đúng
như thiết kế, và là lý do một app mới đọc không ra gì cho tới khi có người viết policy. Nhưng nó
chính là thứ đang chặn G0-4: không thể có bằng chứng LIVE khi chưa có luật nào để chứng minh.

**Hai biến môi trường trống, và hậu quả thật của chúng**
- `INFRA_MAIL_PROVIDER` trống → ai quên mật khẩu sẽ nhận lỗi. Ở dev chỉ cần `console`.
- `INFRA_INTERNAL_TOKEN` trống → **cả hai endpoint theo lịch đang từ chối mọi lời gọi**. Webhook sẽ
  xếp hàng mãi trong `infra_webhook_deliveries`, session mạo danh hết hạn vẫn đọc ra là đang mở, và
  **không có gì báo lỗi** — đúng kiểu hỏng im lặng mà lịch chạy sinh ra để tránh.

**Modified files**
- `scripts/verify-live.mts` (new) · `packages/db/src/queries/inspect.ts` (new) · `queries/index.ts` · `package.json` (edit)

**Test status**
- `pnpm build` → PASS (6/6) · `pnpm test` → PASS (518/518) · không có migration mới.

**Next task** → `G0-4`: viết policy (hoặc chạy `examples/notes-app` setup), đặt `INFRA_MAIL_PROVIDER`
và `INFRA_INTERNAL_TOKEN`, rồi chạy lại `verify:live` để có bằng chứng cho cả bốn.

### 2026-09-14 · v0.7.3 · feat(ops): shared rate-limit counter and a real mail transport

**Deliverables — G0-3 đóng**
- `infra_rate_limits` — bộ đếm **dùng chung**, thay cho bộ đếm trong bộ nhớ tiến trình. Lỗi cũ tệ ở
  chỗ nó **trông như đang chạy đúng**: trên serverless, cùng đoạn mã đó âm thầm nhân mọi hạn mức lên
  theo số instance. Không có lỗi nào, chỉ là trần cao hơn con số ghi trong config.
- Cả phép kiểm nằm trong **một upsert**: chèn cửa sổ mới, hoặc — nếu đã có dòng — hoặc khởi động lại
  (cửa sổ cũ đã qua) hoặc tăng lên. Làm bằng SELECT rồi UPDATE thì vừa **hai** round trip vừa là một
  cuộc đua trong đó hai request cùng đọc 99 rồi cùng ghi 100.
- Lớp trong bộ nhớ **giữ lại nhưng bị giáng cấp xuống thứ nó không thể làm sai**: nó **chỉ được phép
  từ chối, không được phép cho qua**. Nếu riêng instance này đã thấy quá hạn mức trong cửa sổ hiện
  tại thì người gọi cũng đã quá hạn mức toàn cục — đó là số học, không phải phỏng đoán — nên từ chối
  được mà không cần round trip. Thứ gì lớp cục bộ định cho qua thì vẫn phải hỏi bộ đếm chung.
  Thứ tự đó quan trọng vì lưu lượng làm rate limit tốn kém chính là lưu lượng lạm dụng, mà lưu lượng
  lạm dụng đúng là thứ lớp cục bộ đuổi đi được miễn phí.
- Test viết lại quanh **bất biến phủ định**: `localRefusal` **không bao giờ** trả về verdict
  `allowed: true`. Một lớp cục bộ có thể cho qua là một lớp cục bộ có thể nâng trần toàn cục.
- Cửa sổ dùng **fixed window chứ không sliding**, có chủ đích: sliding cần một dòng mỗi request hoặc
  một cấu trúc Postgres không cho rẻ, còn điểm yếu đã biết của fixed window (tối đa 2× hạn mức qua
  ranh giới) chấp nhận được cho một **trần chống lạm dụng**. Nó **không** chấp nhận được cho throttle
  đăng nhập — và đó chính là lý do throttle đó có bảng riêng với đường cong riêng.

**Deliverables — G0-2 gần đóng**
- `@infra/core/mailer` — 3 transport: `console` · `resend` (một lượt HTTPS, không SDK nên không có
  dependency phải theo) · `webhook` (POST tới URL của chính deployment, cho SMTP relay và mọi thứ khác).
- **`none` không phải là một transport.** Deployment chưa cấu hình nhận `unconfigured`: **ném lỗi và
  log to**, không bao giờ thành công trong im lặng. Một luồng khôi phục báo thành công mà không gửi
  gì tệ hơn một luồng hỏng nhìn thấy được.
- Lý do đây là interface chứ không phải một lệnh gọi Resend nội tuyến: luồng khôi phục là **chỗ duy
  nhất mà một lần gửi hỏng không phân biệt được với một cuộc tấn công** đối với người ở đầu kia. Họ
  xin đặt lại mật khẩu và không có gì tới; họ không biết là mail chậm, địa chỉ sai, hay tài khoản đã
  bị ai đó chiếm.
- Địa chỉ trong log **luôn được che** (`al***@example.com`): đủ để lần một dòng log, không đủ để thu
  hoạch địa chỉ.
- `deliverRecoveryLink` giờ **await** và trả về kết quả. Endpoint vẫn trả 202 như nhau dù email có
  tồn tại hay không — nhưng nền tảng cần biết **trong log của chính nó** là mail có đi hay không, vì
  "người dùng nói không nhận được gì" nếu không thì không trả lời nổi.

**Modified files**
- `packages/db/src/schema/rate-limits.ts` · `queries/rate-limits.ts` (new) · `schema/index.ts` · `queries/index.ts` (edit)
- `packages/core/src/mailer.ts` (new) · `src/index.ts` (edit)
- `apps/web/src/lib/rate-limit.ts` (rewrite) · `lib/recovery-delivery.ts` (rewrite) · `lib/guard.ts` (edit)
- `apps/web/src/app/api/v1/auth/recovery/request/route.ts` · `api/internal/maintenance/route.ts` (edit)
- `packages/core/tests/mailer.test.ts` (new) · `apps/web/tests/api.test.ts` (rewrite phần rate limit)
- `packages/db/migrations/0011_brown_dragon_man.sql` (new)

**Test status**
- `pnpm build` → PASS (6/6 package)
- `pnpm test`  → PASS (518 passed / 518 — core 378 · sdk 51 · adapters 45 · web 28 · db 16)
- **Migration mới: `0011`** → Neon giờ cần 0007→0011.

**Notes / decisions**
- Bộ đếm chung **fail open**: một trần chống lạm dụng là lan can, không phải phép kiểm quyền. Database
  là nguồn sự thật nhưng **không được phép là điểm chết duy nhất của cả API**. Mọi phép kiểm quyết
  định ai được thấy gì đều fail closed, ở chỗ khác.
- Bảng rate limit khoá theo **digest**, giống `infra_login_attempts` — bảng không chứa key id hay IP
  dạng đọc được.
- G0-2 **không đánh dấu xong**: mã đã có, nhưng chưa ai đặt `INFRA_MAIL_PROVIDER`. Có transport mà
  chưa cấu hình thì người quên mật khẩu vẫn không lấy lại được tài khoản.

**Next task** → `G0-1` `pnpm db:migrate` (giờ là 0007→**0011**), `G0-2` đặt biến mail, rồi `G0-4`.

### 2026-09-14 · v0.7.2 · chore(ops): ci, the scheduled jobs nobody was calling, and the runbooks

**Deliverables**
- `.github/workflows/ci.yml` — install → build → test → typecheck, và thêm một bước ít ai nghĩ tới:
  **kiểm migration drift**. Chạy `db:generate` rồi fail nếu `packages/db/migrations` bẩn. Sửa schema
  mà quên sinh migration là lỗi chỉ lộ ra lúc deploy, và lúc đó thì đã muộn.
  `env` để trống **có chủ đích**: mọi test trong repo chạy được mà không cần database, không cần
  network, không cần secret. Ngày nào một test cần credential ở đây, đó là dấu hiệu test đó **đã
  thôi là unit test**, chứ không phải dấu hiệu CI cần secret.
- `POST /api/internal/maintenance` — gom ba job dọn. **Mỗi job đã được viết cùng lúc với tính năng
  nó dọn, và mỗi job không làm gì cả cho tới khi có ai đó gọi.** Khoảng trống đó là kiểu hỏng
  production im lặng: hệ thống chạy hoàn hảo một tháng, rồi một phiên mạo danh hết hạn từ ba tuần
  trước vẫn đọc ra là đang hoạt động vì không có gì đóng nó lại.
- Mỗi job chạy độc lập, một cái hỏng không chặn các cái còn lại — một lượt dọn không chạy được thì
  đáng báo cáo, không đáng bỏ luôn cả lượt.
- `lib/internal-auth.ts` — gom phép kiểm token nội bộ (drain đang tự viết lại). **Chưa đặt
  `INFRA_INTERNAL_TOKEN` thì không ai qua được**: cửa đóng chứ không phải cửa mở. Deploy quên biến
  này sẽ thấy 401 trong log scheduler — thứ có người để ý; lựa chọn còn lại là một endpoint công
  khai trong im lặng, thứ không ai để ý.
- `docs/runbooks.md` — 6 runbook, mỗi cái có **điều kiện dừng**: chỗ mà thấy dấu hiệu đó thì dừng
  chứ không đi tiếp. Xoay khoá mã hoá · backup/restore · tài khoản bị chiếm · app đọc không ra dữ
  liệu · lịch chạy · trước khi deploy nhiều instance.

**Modified files**
- `.github/workflows/ci.yml` · `docs/runbooks.md` (new)
- `apps/web/src/lib/internal-auth.ts` · `app/api/internal/maintenance/route.ts` (new)
- `apps/web/src/app/api/internal/webhooks/drain/route.ts` (edit — dùng chung phép kiểm token)
- `process.md` (edit — G1-3/G1-4/G1-5 đóng, G1-1/G1-2 hạ xuống "đã có runbook, chưa diễn tập")

**Test status**
- `pnpm build` → PASS (6/6 package, thêm route `/api/internal/maintenance`)
- `pnpm test`  → PASS (503 passed / 503)
- Không có migration mới.

**Notes / decisions**
- Runbook xoay khoá đặt **bài diễn tập lên trước quy trình thật**, và nói thẳng: chưa diễn tập thì
  chưa được xoay trên Master DB thật. Đây là thao tác nguy hiểm nhất trong hệ thống — mất khoá là
  mất mọi connection string, không có đường về.
- Runbook "tài khoản bị chiếm" có một điều kiện dừng đáng chú ý: thấy `auth.token.reuse_detected`
  **đừng vội kết luận là tấn công** — một app con dùng SDK cũ không gộp refresh single-flight sinh
  ra **đúng dấu hiệu đó** (ADR-018).
- G1-1 và G1-2 **không đánh dấu xong**, chỉ hạ mức: runbook đã viết nhưng chưa ai chạy. Viết ra rồi
  tick xong là cách tự lừa mình.

**Next task** → `G0-1` `pnpm db:migrate`, rồi `G0-4` chạy thật app mẫu.

### 2026-09-14 · v0.7.1 · docs(repo): bring tech.md and the readme back in line with the system

**Deliverables**
- `tech.md` §8 viết lại. Bản cũ **dạy sai**: nó bảo dùng khoá `pk_` để chạy SQL thô và chú thích
  "CHỈ phía server" — mâu thuẫn với chính mô hình bảo mật hiện tại theo hai hướng cùng lúc. Đây là
  file mọi phiên đọc **đầu tiên** theo Anchor Protocol, nên sai ở đây là loại sai đắt nhất: nó
  không chỉ lỗi thời, nó hướng dẫn người đọc làm điều nguy hiểm.
- `tech.md` §4.0 — bảng kiểm kê **25 bảng theo phase sinh ra chúng**, thay cho câu "4 bảng nghiệp vụ".
- `tech.md` §8.3 — bảng API surface đầy đủ, nói rõ endpoint nào có rules engine và endpoint nào không.
- `tech.md` §8.4 — ngữ pháp Query DSL: toán tử, trần, thứ bị cấm, và **vì sao không có `like`**.
- **ADR-017 → ADR-024** — tám quyết định của Phase 5–8 mà trước đó chỉ sống trong worklog và trong
  comment mã nguồn. Một quyết định không nằm trong ADR log là một quyết định sẽ bị ai đó lật lại vì
  tưởng nó tuỳ tiện.
- `README.md` viết lại. Bản cũ nói "Phases 1–4 are implemented", liệt kê 9 bảng, và cũng dán nhãn
  `pk_live_` là "server side only".
- **`process.md` §5 — v1.0 Readiness.** Danh sách khoảng cách thật, chia ba mức: 4 mục **chặn v1.0**,
  6 mục nên làm trước khi có người dùng thật, 5 rủi ro đã biết và chấp nhận có lý do.

**Modified files**
- `tech.md` (edit — §4, §8, §13) · `README.md` (rewrite) · `process.md` (edit — thêm §5)

**Test status**
- `pnpm build` → PASS (6/6 package)
- `pnpm test`  → PASS (503 passed / 503)
- Không đổi mã nguồn, không có migration mới.

**Notes / decisions**
- **"Xong 8 phase" không bằng "chạy được thật", và mục §5 tồn tại để không ai nhầm hai thứ đó** —
  kể cả mình ở phiên sau. 503 test chứng minh các mảnh đúng và đường nối khớp; **chưa có gì chứng
  minh một app con thật đọc được dữ liệu thật qua policy thật.**
- Khoảng cách chặn nhất **không phải mã nguồn**: 4 migration chưa apply, và chưa có mailer nên
  người quên mật khẩu không lấy lại được tài khoản.
- Ghi rõ một thứ dễ bị bỏ sót khi deploy: `lib/rate-limit.ts` đếm trong bộ nhớ tiến trình, nên lên
  serverless là mỗi instance một bộ đếm. `infra_login_attempts` nằm trong DB nên không dính, nhưng
  rate limit của `/api/v1/*` thì có.

**Next task** → `G0-1` chạy `pnpm db:migrate`, rồi `G0-4` chạy thật app mẫu để có bằng chứng LIVE.

### 2026-09-14 · v0.7.0 · feat(examples): a child app in nine lines, and the test that proves the seam holds

**Deliverables**
- `examples/notes-app` — app con nhỏ nhất có thể: không framework, không build step. Thứ cần chứng
  minh là **nền tảng**, không phải công sức dựng app. Trỏ sang AI Study OS chỉ là đổi `APP_SLUG` và
  tên bảng trong `setup.mts`.
- Bản trình duyệt đúng **chín dòng**. Khoá `pk_` nằm trong bundle — công khai theo thiết kế — và điều
  đó an toàn vì người gọi không viết được SQL tuỳ ý và không thoát được bộ lọc dòng.
  **Người dùng chỉ thấy note của chính họ, mà câu truy vấn không hề nhắc tới `owner_id`.** Sự cách ly
  nằm ở policy trên hub; mã app con không biết nó tồn tại — đúng thứ một app con đáng được nhận
  miễn phí.
- `setup.mts` **idempotent**: chạy lần hai thì dùng lại thứ đã có thay vì chất đống bản sao. Chuyện
  này quan trọng hơn nghe có vẻ — một script chỉ chạy được trên database sạch là script không ai dám
  chạy, và lần chạy thứ hai luôn là lần chạy lúc đang gấp.
- `setup.mts` bước 4 là bước thật sự quan trọng: **viết bốn policy**. Bỏ nó đi thì app không đọc
  được gì cả. Mặc định là từ chối, và điều đó **cố ý gây khó chịu** — một nền tảng mà app mới đọc
  được mọi thứ cho tới khi ai đó nhớ ra phải khoá lại là một nền tảng rò rỉ dữ liệu ngay ngày đầu.

**🔗 T8.7 — test đường nối, thứ mà 492 test trước đó không chạm tới**
Mọi test khác trong repo kiểm **một package**. Test này đi xuyên tất cả: lấy **đúng JSON** mà builder
của SDK đặt lên dây, đưa vào **đúng parser** mà endpoint dùng, biên dịch với một quyết định policy
thật, rồi kiểm câu lệnh đi ra.

Đó là chỗ một nền tảng hỏng trong im lặng. SDK ship từ một package, ngữ pháp từ package khác; thêm
một toán tử vào builder mà quên ngữ pháp, thì lỗi **chỉ hiện ra trong app của khách, lúc chạy, dưới
dạng một cái 422 mà không bên nào giải thích được**. Nên test hợp đồng **liệt kê toàn bộ từ vựng**
của builder chứ không lấy mẫu: 11 toán tử, 4 hành động, và khẳng định payload của builder không bao
giờ mang một khoá mà ngữ pháp sẽ từ chối.

**Modified files**
- `examples/notes-app/{README.md,package.json,setup.mts,demo.mts}` (new)
- `apps/web/tests/end-to-end.test.ts` (new)
- `pnpm-workspace.yaml` · `apps/web/package.json` (edit)

**Test status**
- `pnpm build` → PASS (6/6 package)
- `pnpm test`  → PASS (503 passed / 503 — core 365 · sdk 51 · adapters 45 · web 26 · db 16)
- Không có migration mới.

**Notes / decisions**
- `demo.mts` chứng minh bằng **hai danh tính, một bảng**: điểm mấu chốt không phải là đọc được, mà là
  người thứ hai **không** thấy dòng của người thứ nhất — và không dòng nào trong file đó nói thế.
- Đã chọn dựng app mẫu trong repo thay vì nối thẳng AI Study OS: như vậy chứng minh được **ngay bây
  giờ** trong CI mà không chặn ở việc phải có credential. Nối app thật chỉ còn là đổi hai biến.

**Next task** → chạy thật: `pnpm db:migrate` cho 0007→0010, rồi `setup` app mẫu trên Neon để có bằng
chứng LIVE chứ không chỉ bằng chứng trong test.

### 2026-09-14 · v0.6.2 · feat(dashboard): access rules, service accounts and workspaces in the ui

**Deliverables**
- `/apps/[appId]/access` — trang cấu hình **policy trước, role sau**, vì policy mới là phần người ta
  làm sai. Mỗi dòng policy hiển thị **mảnh SQL mà nó biên dịch ra**, với giá trị của subject hiện
  dưới dạng placeholder đọc được (`:current_user`). Đây là điểm chính của cả trang: một màn hình
  rules chỉ liệt kê tên policy thì **không nói gì** về việc nó thực sự làm gì — nhìn thấy SQL mới là
  thứ khiến "policy này cho phép nhiều hơn mình tưởng" bị bắt **trước khi** lên production chứ không
  phải sau.
- Form policy có **từ vựng cố tình nhỏ**: tối đa 3 mệnh đề AND với nhau, thay vì trình soạn cây tự
  do. Các hình dạng người ta thực sự viết ("dòng của tôi", "dòng trong workspace của tôi", "dòng chưa
  xoá mềm") đều vừa, mà **một UI diễn đạt được mọi thứ là một UI không ai liếc qua mà biết policy làm gì**.
- **Từ chối thẳng một tổ hợp**: `allow` + resource `*` + điều kiện `always` — đó là "tắt bộ lọc dòng",
  và nó phải là một hành động có chủ đích chứ không phải hai cái dropdown. Chọn `always` + `allow`
  trên một bảng cụ thể thì hiện cảnh báo tại chỗ.
- App chưa có policy nào thì trang nói thẳng: **mọi request qua `/api/v1/data` đang bị từ chối** —
  đó là mặc định an toàn, và cũng là lý do một app mới đọc không ra gì cho tới khi có người viết
  policy ở đây. Nói ra tốt hơn để người dùng tự đoán.
- Grant có **hạn tự hết** (1/7/30 ngày, hoặc không) và cột `Expires` tô vàng chữ "never" — một grant
  tự hết hạn là loại an toàn nhất vì không ai phải nhớ đi thu lại.
- Permission được **parse** chứ không chỉ khớp regex, nên một permission viết sai bị chặn ngay tại
  form thay vì lọt xuống và âm thầm không khớp gì cả trong `hasPermission`.
- `/apps/[appId]/machines` — service account + workspace. Cột IP allowlist tô vàng chữ "anywhere"
  khi để trống. Mỗi entry được kiểm bằng cách **đem khớp với chính nó**: một CIDR viết sai sẽ không
  khớp gì cả, tức là âm thầm khoá tài khoản khỏi *mọi nơi* thay vì giới hạn nó ở *một nơi*.
- Khoá service account trả về **đúng một lần** qua `RevealOnce`, và luôn là `sk_`.

**Modified files**
- `packages/db/src/queries/access.ts` (edit — `listRoleAssignments`)
- `apps/web/src/actions/{access,machines}.ts` (new)
- `apps/web/src/app/(dashboard)/apps/[appId]/{access,machines}/page.tsx` (new)
- `apps/web/src/components/{policy-form,policy-row-actions,create-role-form,assign-role-form,assignment-row-actions,service-account-form,service-account-row-actions,workspace-form}.tsx` (new)
- `apps/web/src/app/(dashboard)/apps/[appId]/page.tsx` (edit — link sang 2 trang mới)

**Test status**
- `pnpm build` → PASS (6/6 package, `next build` thêm 2 route)
- `pnpm test`  → PASS (492 passed / 492)
- Không có migration mới.

**Notes / decisions**
- **T8.5 đánh dấu xong mà không viết thêm gì**: MFA factor, passkey, thiết bị đã nhớ và danh sách
  phiên đều đã nằm ở `/security/sessions` từ Phase 5. Thêm một trang nữa chỉ là lặp lại.
- Preview SQL **render phía server**. Biên dịch cần `compileCondition` từ `@infra/core`, mà package
  đó re-export cả `node:crypto` qua index — kéo nó vào client component sẽ vỡ bundle trình duyệt.

**Next task** → `T8.7` tích hợp thật một app con (AI Study OS) làm bằng chứng dưới 10 dòng, rồi đóng
gate G8.

### 2026-09-14 · v0.6.1 · feat(sdk): request-scoped server client and single-flight token refresh

**Deliverables**
- `token-manager.ts` — **hàng đợi refresh ở đây không phải tối ưu, mà là điều kiện đúng đắn.**
  Access token sống 10 phút. Cách xử lý ngây thơ (để hết hạn → nhận 401 → refresh → thử lại) hỏng
  vì đúng một tính năng nền tảng này cố tình có: refresh token **xoay vòng**, và một token dùng lại
  sẽ kích hoạt reuse detection, **thu hồi toàn bộ session trong family** (`rotateRefreshToken`).
  Nên khi một trang bắn 5 request song song với token cũ: 5 cái 401, 5 lượt refresh khởi động, một
  cái thắng, **4 cái còn lại trình ra token server vừa đốt**. Server làm đúng thứ nó được xây để
  làm — kết luận token bị đánh cắp và đăng xuất người dùng khỏi mọi nơi. Người dùng thấy "app tự
  đăng xuất khi tải nặng", mà **mọi tầng đều đang hành xử đúng**.
  Bốn luật rút ra:
  · **Single-flight** — người đầu tiên cần refresh thì khởi động, mọi người còn lại *await cùng một
    promise*. Một lượt gọi mạng, một lượt xoay, một token mới cho tất cả.
  · **Chủ động** — refresh *trước* khi hết hạn 60 giây, nên thường không ai phải chờ và không
    request nào nhìn thấy 401.
  · **Thử lại đúng một lần, không bao giờ lặp** — 401 sống sót qua một token vừa mới đúc là từ chối
    thật, và thử lại nó là cách biến một request bị từ chối thành một lệnh cấm vì quá tải.
  · **Family bị thu hồi là điểm cuối** — không còn gì để thử lại; xoá trạng thái và báo ra, thay vì
    nện vào một endpoint sẽ từ chối mãi.
- `server-client.ts` — khác `createInfraClient` **không phải ở danh sách tính năng mà ở vòng đời**.
  Client trình duyệt là một object phục vụ một người dùng suốt thời gian mở tab. Client server
  *trông giống hệt* nhưng không phải: cùng một tiến trình phục vụ hàng nghìn người, và **bất kỳ
  trạng thái người dùng nào sống lâu hơn một request đều là rò rỉ chéo người dùng** — token của A
  nằm trong biến module rồi phục vụ trang của B, B thấy dữ liệu của A, **không có lỗi ở đâu cả**.
  Đó là bug tìm ra từ ticket hỗ trợ chứ không từ stack trace.
  Nên API được đẽo cho khó viết sai: `storage` là **bắt buộc**, token của mỗi request nằm ở đó;
  client không giữ token nào của riêng nó; chạy trong trình duyệt thì **ném lỗi thẳng**.
- Token người dùng đi trong header `x-infra-access-token`, **không bao giờ trong cookie** — hub nằm
  ở domain riêng, và cả kiến trúc này né cookie bên thứ ba có chủ đích.
- `signOut` **xoá cục bộ trước, gọi revoke sau**: kể cả khi không với tới hub, tiến trình này phải
  ngừng trình ra token ngay lập tức.

**Modified files**
- `packages/sdk/src/{token-manager,server-client}.ts` (new)
- `packages/sdk/src/{query-builder,index}.ts` (edit — móc `BuilderAuth` cho retry-once)
- `packages/sdk/tests/{token-manager,server-client}.test.ts` (new)

**Test status**
- `pnpm build` → PASS (6/6 package)
- `pnpm test`  → PASS (492 passed / 492 — core 365 · sdk 51 · adapters 45 · web 15 · db 16)
- Không có migration mới.

**Notes / decisions**
- Test quan trọng nhất của `server-client` là test **cách ly hai request đồng thời**. Kiểu hỏng đó
  im lặng trong production (trang của B render dữ liệu của A, không lỗi ở đâu), nên nó phải có test
  riêng chứ không phải một quy ước.
- `T8.3` đánh dấu xong: query builder đã ship ở v0.5.1.

**Next task** → `T8.4` UI quản lý role/permission/policy, rồi `T8.5`/`T8.6` và `T8.7` tích hợp thật
một app con.

### 2026-09-14 · v0.6.0 · feat(gateway): decision log with bounded aggregation, and the adversarial suite that found a hole

**Deliverables**
- `decision-log.ts` — cách hiển nhiên (mỗi quyết định một dòng audit) là cách **sai** ở đây. Một
  dashboard poll vài giây một lần sinh ra hàng nghìn dòng "allowed" giống hệt nhau mỗi ngày, và
  trên Master DB free tier 0.5 GB thì **nhật ký của chuyện đã xảy ra sẽ lớn hơn chính dữ liệu nó
  mô tả** trong vòng một tuần. Lúc đó job xoá log cũ trở thành thứ chịu lực, và lần đầu nó hỏng là
  nền tảng ngừng nhận ghi.
  Nên hai nửa được đối xử khác nhau, vì chúng **được dùng khác nhau**:
  · **Từ chối ghi từng dòng một** — hiếm, và mỗi lần là một câu hỏi sẽ có người đi tìm lời đáp:
    vì sao user này không thấy dòng kia? Một lần từ chối không có bản ghi là một ticket không có
    câu trả lời.
  · **Cho phép thì gộp lại trong bộ nhớ** thành đếm + histogram độ trễ theo (resource, action),
    xả một dòng mỗi cửa sổ. Trả lời được "rules có chậm không" và "bảng nào nóng" mà không giữ
    một dòng cho mỗi lượt đọc.
- Histogram dùng **bucket log**, percentile trả về **cận trên của bucket** — tức là ước lượng
  **cao hơn** thực tế. Con số này đem so với ngân sách độ trễ, nên sai lệch phải nghiêng về phía an
  toàn.
- `DecisionMetrics` **có trần cứng** 200 khoá: một caller lặp qua các tên resource bịa ra không thể
  làm map phình mãi. Số khoá bị bỏ được đếm, để khoảng trống là thứ **nhìn thấy được** chứ không im lặng.
- Flush kích hoạt bằng **lưu lượng, không bằng timer**: worker serverless có thể bị đóng băng giữa
  các request, nên `setInterval` hoặc không bao giờ chạy, hoặc chạy trên một tiến trình không ai dùng.
- `GatewayPlan.overheadMs` đo **riêng thời gian của rules engine**, không lẫn thời gian của database
  tenant — một con số gộp cả hai sẽ khiến rules engine trông đắt đỏ và đẩy người ta đi tối ưu nhầm chỗ.
- **T7.6 — bộ test tấn công có chủ đích.** Viết từ phía kẻ tấn công: mỗi test là một nỗ lực đưa giá
  trị vào phần *văn bản* SQL, nới rộng điều kiện policy, hoặc chạm tới bảng mình không có quyền.
  Chúng khẳng định thứ kẻ tấn công **không** lấy được — nên nhiều test kiểm tra sự *vắng mặt* của
  một chuỗi, chứ không phải sự có mặt: một lớp phòng thủ sinh ra SQL trông hợp lý mà vẫn rò rỉ chính
  là kiểu hỏng mà test "có trả về dòng nào không" sẽ bỏ sót. Có cả một lượt fuzz 300 chuỗi ngẫu nhiên
  từ bảng chữ cái toàn ký tự nguy hiểm.

**🔴 Lỗi thật do bộ test tấn công tìm ra**
`__proto__`, `constructor`, `prototype` **lọt qua** phép kiểm định danh — chúng chỉ gồm chữ và gạch
dưới nên khớp `IDENTIFIER_PATTERN`. Hậu quả: `row['__proto__'] = 'x'` trên một object thường **âm
thầm không đặt gì cả** — khoá biến mất, danh sách cột rỗng, và compiler sinh ra
`insert into "notes" () values ()`. Đã sửa bằng cách từ chối thẳng ba tên đó; rõ ràng hơn là đổi
row sang object không prototype, vì cách này đồng thời chặn chúng ở cả `select`, `order`, `returning`.

**Modified files**
- `packages/core/src/decision-log.ts` (new) · `src/{query-dsl,index}.ts` (edit)
- `packages/auth/src/gateway.ts` (edit — `overheadMs`)
- `apps/web/src/lib/decision-log.ts` (new) · `app/api/v1/data/[resource]/route.ts` (edit)
- `packages/db/src/schema/audit-logs.ts` (edit — `access.decision.summary`)
- `packages/sdk/src/query-builder.ts` (edit — `select([...])`, `order()`, `execute()`)
- `packages/core/tests/{decision-log,adversarial-gateway}.test.ts` (new)

**Test status**
- `pnpm build` → PASS (6/6 package)
- `pnpm test`  → PASS (465 passed / 465 — core 365 · adapters 45 · sdk 24 · web 15 · db 16)
- Không có migration mới.

**Notes / decisions**
- `'notes '` (thừa khoảng trắng) **được chấp nhận sau khi trim**, không bị từ chối — đây là lỗi gõ
  chứ không phải tấn công, và tên sau khi trim vẫn phải qua phép kiểm định danh. Đã viết hẳn một
  test nói rõ điều đó thay vì để nó là giả định ngầm.
- Từ chối được ghi **trước khi** lỗi lan ra ngoài, nên một request bị chặn không bao giờ vô hình.

**Next task** → **Phase 8**: `createServerClient()` cho Server Component/BFF, hàng đợi tự làm mới
token, và giao diện Dashboard để cấu hình rules trực quan.

### 2026-09-14 · v0.5.1 · feat(gateway): typed query dsl, dual-dialect compiler and the rules-enforced data endpoint

**Deliverables**
- `query-dsl.ts` — ngữ pháp JSON có kiểu, **không có cửa thoát**: không `raw`, không mảnh `sql`,
  không `having` tự do. Một cửa thoát là đủ để 99 luật còn lại thành trang trí.
  Ba luật là an toàn chứ không phải khẩu vị:
  · **Khoá lạ bị từ chối, không bị bỏ qua** — client gửi `wheres` thay vì `filters` rồi nhận về
    dữ liệu chưa lọc thì tệ hơn nhận lỗi: nó *tin là mình đã lọc*.
  · **`update`/`delete` bắt buộc có ít nhất một filter** — policy dễ dãi biên dịch ra `1 = 1`, nên
    `delete ... where 1 = 1` là cả bảng. Thiếu WHERE phải là điều **không diễn đạt nổi**.
  · **`limit` có trần và có mặc định** — select không giới hạn trên DB free tier 0.5 GB là một cú
    DoS tốn của kẻ tấn công đúng một request.
- **Bỏ hẳn `like`, chỉ giữ `ilike`.** Postgres `LIKE` phân biệt hoa thường, SQLite `LIKE` thì không.
  Giữ cả hai nghĩa là cùng một câu truy vấn trả kết quả khác nhau tuỳ app con nằm ở nhà cung cấp
  nào. Một toán tử một nghĩa đáng giá hơn hai toán tử kèm một cái bẫy.
- `query-compiler.ts` — hợp đồng một câu: **không chuỗi nào của người gọi lọt vào `sql`**. Test
  khẳng định sự *vắng mặt* của chuỗi người gọi, chứ không chỉ sự có mặt của placeholder.
  `limit`/`offset` cũng bind dù chúng là số do chính module sinh ra — để trong file này **không tồn
  tại tiền lệ "nội suy an toàn"** cho một lần sửa sau copy theo.
- `ConditionCompiler` nhận **cả `startIndex` lẫn `dialect`**. Đây là sửa do một test bắt được: điều
  kiện biên dịch kiểu postgres (`$1`) ghép vào câu libsql (`?`) trông vẫn *hợp lệ* — văn bản đúng,
  mảng tham số thiếu đúng một phần tử, và **mọi giá trị sau đó bind lệch cột**. Để compiler quyết
  định dialect thì sai lầm đó biến mất khỏi API.
- `evaluateDecisionForRow` — INSERT không có WHERE để gắn điều kiện, nên policy được chấm **trực
  tiếp trên dòng dữ liệu**. Phần quan trọng là `undecidable`: policy đòi `owner_id` mà dòng không
  đặt `owner_id` thì câu trả lời **không phải "cho phép"** — cột đó sẽ nhận DEFAULT của bảng. Coi
  đó là cho phép chính là cách một dòng ra đời mà không thuộc về ai.
- `gateway.ts` — `checkAccess` → (insert: chấm dòng) → biên dịch với điều kiện AND vào.
  `appId` từ khoá API đã xác thực, subject từ access token đã xác thực, dialect từ config DB của
  chính app. Body chỉ được quyết định **hình dạng và giá trị**, không gì khác.
- `POST /api/v1/data/:resource` — chấp nhận `pk_`, vì khoá publishable **công khai theo thiết kế**
  và điều đó chỉ an toàn khi người gọi *không thể* viết SQL tuỳ ý và *không thể* thoát khỏi bộ lọc
  dòng. `/api/v1/query` giữ nguyên: SQL thô, chỉ `sk_`.
- Không có access token và khoá không thuộc service account → **từ chối**, không coi là ẩn danh.
  Đọc ẩn danh là thứ app phải bật có chủ đích, mà cơ chế đó chưa tồn tại.
- `QueryBuilder` trong SDK — `infra.from('notes').select('id').eq('done', false)`. Lớp mỏng có chủ
  đích: **bỏ qua nó cũng không thay đổi gì**, vì server parse lại mọi thứ. Một builder mà server
  tin tưởng là một builder kẻ tấn công chỉ việc không dùng.

**Modified files**
- `packages/core/src/{query-dsl,query-compiler}.ts` (new) · `src/{policy,index}.ts` (edit)
- `packages/auth/src/gateway.ts` (new) · `src/index.ts` (edit)
- `apps/web/src/app/api/v1/data/[resource]/route.ts` (new)
- `packages/sdk/src/query-builder.ts` (new) · `src/{client,types,index}.ts` (edit)
- `packages/core/tests/{query-dsl,query-compiler,row-policy}.test.ts` (new)
- `packages/sdk/tests/query-builder.test.ts` (new)

**Test status**
- `pnpm build` → PASS (6/6 package)
- `pnpm test`  → PASS (429 passed / 429 — core 329 · adapters 45 · sdk 24 · web 15 · db 16)
- Không có migration mới: Phase 7 chưa thêm bảng nào.

**Notes / decisions**
- Điều kiện policy được **biên dịch lại bên trong** compiler thay vì dùng `access.condition` có sẵn:
  chỉ compiler mới biết chỉ số placeholder cuối cùng, và một điều kiện đánh số theo phỏng đoán sẽ
  bind mọi giá trị sau đó vào sai cột.
- Mảnh điều kiện **luôn được bọc ngoặc**, kể cả khi thừa: một mảnh `a or b` không bọc, đem AND với
  filter của người gọi, sẽ kết hợp lỏng hơn dự định và **nới rộng kết quả**.
- Client chỉ có thể thu hẹp: test cố lọc `owner_id = 'user_2'` vẫn AND với `owner_id = 'user_1'`
  của server → câu lệnh trả về rỗng, không phải dữ liệu người khác.

**Next task** → `T7.5` decision log + đo overhead của rules, rồi `T7.6` bộ test adversarial khép
gate G7 và bump v0.6.0.

### 2026-09-13 · v0.5.0 · feat(admin): time-boxed impersonation with a required reason and a standing banner

**Deliverables**
- `infra_impersonation_sessions` — bốn ràng buộc nằm ở **cấu trúc bảng**, không phải ở quy trình,
  nên không ai "vội quá nên bỏ qua" được: `reason` NOT NULL · `expires_at` NOT NULL ·
  `ended_at`/`ended_reason` phân biệt "hết giờ" với "chủ động dừng" · `read_only` mặc định **true**.
- `startImpersonation` — chính các lệnh **từ chối** mới là tính năng:
  · không tự mạo danh chính mình;
  · **không mạo danh platform admin khác** — đó là đường đi ngang vào quyền của một admin thứ hai
    mà chỉ cần credential của mình, đúng con đường leo thang phải chặn;
  · lý do dưới 12 ký tự bị từ chối — một lý do không ai xử lý được thì bằng không có lý do;
  · **không mở phiên thứ hai** khi phiên cũ còn sống, vì hai phiên mở cùng lúc làm audit trail mơ hồ
    về việc hành động thuộc phiên nào — mà sự rõ ràng đó chính là toàn bộ giá trị của bản ghi.
- Trần cứng **60 phút**; cần lâu hơn thì mở phiên mới với lý do mới. `expireImpersonations` đóng
  phiên quá hạn để không còn dòng nào trông như đang mở mãi mãi.
- `ImpersonationBanner` — **không phải trang trí mà là cái làm cho tính năng này an toàn để dùng.**
  Thiếu một dấu hiệu thường trực, admin quên mình đang nhìn tài khoản ai, và thao tác kế tiếp rơi
  vào dữ liệu khách hàng trong khi tưởng là của mình. Banner nằm ở **layout**, hiện trên mọi trang
  dashboard, ghi rõ đang là ai · read-only hay không · còn bao nhiêu phút · và mang nút thoát.
- Móc vào claim `act` sẵn có của JWT: token phát trong lúc mạo danh có `sub` = người bị mạo danh và
  `act` = người thật. Audit chỉ nhìn `sub` sẽ ghi hành động của bộ phận hỗ trợ thành hành động của
  khách hàng — test khoá đúng điểm này, kể cả trường hợp cố nhét `act` vào token sau khi đã ký.

**Modified files**
- `packages/db/src/schema/impersonation.ts` · `queries/impersonation.ts` (new)
- `packages/db/src/schema/{audit-logs,index}.ts` · `queries/index.ts` (edit)
- `apps/web/src/actions/impersonation.ts` (new)
- `apps/web/src/components/{impersonation-banner,stop-impersonation-button}.tsx` (new)
- `apps/web/src/app/(dashboard)/layout.tsx` (edit)
- `packages/core/tests/impersonation-policy.test.ts` · `packages/db/tests/impersonation.test.ts` (new)
- `packages/db/migrations/0010_keen_bromley.sql` (new)

**Test status**
- `pnpm build` → PASS (6/6 package)
- `pnpm test`  → PASS (365 passed / 365 — core 277 · adapters 45 · web 15 · sdk 12 · db 16)

**Notes / decisions**
- `beginImpersonation` gọi lại `requireSuperAdmin()` (allowlist env + dòng admin active + MFA còn
  hạn 8 giờ) ngay trong server action: **một server action không bao giờ được tin rằng trang render
  ra form đã canh cửa hộ nó**.
- `read_only` mặc định true và phải xin mới có quyền ghi — nhìn là việc thường, hành động là ngoại lệ.
- Banner gọi `expireImpersonations` trước khi hỏi phiên nào đang sống, nên một phiên đã hết giờ
  **không bao giờ render ra như đang hoạt động**.

**Next task** → **Phase 7** — Data API Gateway: Query DSL có kiểu → SQL tham số hoá cho cả hai
phương ngữ, policy áp phía server, tách `/api/v1/data/:resource` (pk_) khỏi `/api/v1/query` (sk_).

### 2026-09-13 · v0.4.1 · feat(provisioning): neon and turso auto-provisioning with quota tracking

**Deliverables**
- `provisioning/types.ts` — hợp đồng `DatabaseProvisioner`: `provision` · `deprovision` · `usage`,
  cộng `isConfigured()` để UI làm mờ nhà cung cấp chưa có credential thay vì để nó lỗi lúc chạy.
- `neon.provisioner.ts` — **một project cho mỗi app con**, không phải branch: project mới là đơn vị
  Neon cô lập và tính hạn mức. Hai app dùng chung project sẽ dùng chung compute endpoint và chung
  quota — đúng thứ nền tảng này sinh ra để tránh.
- `turso.provisioner.ts` — tạo database rồi mint token **chỉ cho riêng database đó**. Một token
  cấp org đưa vào config của một app sẽ là chìa khoá mở dữ liệu của mọi app khác.
- **Không bao giờ để lại rác.** Provision là nhiều lệnh API nối nhau; lệnh sau hỏng thì lệnh trước
  bị xoá trước khi ném lỗi. Free tier 10 slot đầy rất nhanh nếu mỗi lần lỗi để lại một project.
- `infra_provisioned_resources` — ghi lại **external id** do nhà cung cấp trả về, và dùng
  `on delete set null` để dòng này **sống lâu hơn dòng app**: một project Neon còn tồn tại mà không
  ai biết là một slot mất vĩnh viễn. Thất bại giải phóng 5 lần → `orphaned` để người thật nhìn thấy.
- `infra_provider_quotas` + `checkQuota` — **fail open** khi chưa có số liệu: từ chối tạo app chỉ vì
  một job nền chưa chạy là biến job nền thành thứ chặn đường. Poll lỗi thì ghi `lastError` và
  **giữ nguyên số cũ**, không ghi 0 — ghi 0 sẽ đọc thành "còn rất nhiều chỗ".
- `apps/web/src/lib/provisioning.ts` — thứ tự: tạo ở nhà cung cấp → **ghi sổ** → niêm phong DSN.
  Hỏng ở giữa thì xoá tài nguyên từ xa (chưa ai trỏ tới nó); hỏng ở bước cuối thì **giữ sổ** và
  hoàn tác — sổ không có config thì lượt reclaim còn nhìn thấy, mất sổ thì không.
- `providerFetch` — timeout cứng, và lỗi **chỉ mang status code, không bao giờ mang response body**:
  nhà cung cấp echo lại một phần request vào thông báo lỗi chính là cách một API token lọt vào log.

**Modified files**
- `packages/adapters/src/provisioning/{types,http,neon.provisioner,turso.provisioner,index}.ts` (new)
- `packages/adapters/src/index.ts` (edit)
- `packages/db/src/schema/provisioning.ts` · `queries/provisioning.ts` (new)
- `packages/db/src/schema/{audit-logs,index}.ts` · `queries/index.ts` (edit)
- `apps/web/src/lib/provisioning.ts` (new)
- `packages/adapters/tests/provisioning.test.ts` · `packages/db/tests/provisioning.test.ts` (new)
- `packages/db/migrations/0009_exotic_elektra.sql` (new)

**Test status**
- `pnpm build` → PASS (6/6 package)
- `pnpm test`  → PASS (359 passed / 359 — core 273 · adapters 45 · web 15 · sdk 12 · db 14)

**Notes / decisions**
- **Supabase không có API tạo project ở free tier**, nên nó vắng mặt một cách có chủ đích trong
  registry: `createProvisioner('supabase')` ném lỗi nói thẳng điều đó. Hứa hỗ trợ rồi hỏng lúc chạy
  còn tệ hơn nói không ngay từ đầu.
- Provisioner nhận `fetchImpl` để test chạy trên một fetch kịch bản — thứ cần chứng minh ở đây không
  phải là API của Neon hoạt động, mà là **hỏng giữa chừng không để lại tài nguyên mồ côi**.
- Credential nhà cung cấp đọc từ env (`NEON_API_KEY`, `TURSO_API_TOKEN`, `TURSO_ORGANIZATION`),
  **không** thêm vào `serverEnvSchema`: thiếu chúng thì tính năng tắt, chứ không làm sập cả tiến trình.

**Next task** → `T6.5` impersonation có lý do + hạn giờ + banner + audit.

### 2026-09-13 · v0.4.0 · feat(webhooks): signed identity events, ssrf-guarded delivery and the G5 security suite

**Deliverables**
- `webhook.ts` — chữ ký HMAC-SHA256 trên **`timestamp.body`**, gửi dạng `t=…,v1=…`, so khớp
  constant-time trong cửa sổ 5 phút. Ký mỗi body là lỗi kinh điển: làm vậy thì mọi delivery đều
  **replay được vĩnh viễn**. Timestamp nằm *trong* phần được ký nên không sửa được để nới cửa sổ.
- `isPublicHttpUrl` — chốt chặn **SSRF**. Webhook nghĩa là nền tảng tự gửi request tới địa chỉ do
  tenant chọn, từ bên trong mạng của mình. Chỉ nhận https, cổng 443, không credential trong URL;
  chặn loopback, RFC1918, link-local (**169.254.169.254 — metadata endpoint của cloud**), CGNAT,
  `.local`/`.internal`, IPv6 ULA.
- `webhook-dispatch.ts` — **từ chối redirect** (`redirect: 'manual'`): một host công khai 302 về
  169.254.169.254 sẽ vô hiệu hoá mọi phép kiểm URL đơn thuần. Có timeout cứng 8s, và **không đọc
  response body** — đó là văn bản do bên kia kiểm soát, đọc nó là tự rước slow-loris.
- `infra_webhook_endpoints` / `infra_webhook_deliveries` — secret ký lưu bằng **AES-256-GCM** với
  AAD buộc theo dòng; hàng đợi nằm trong **bảng chứ không phải timer trong tiến trình**, vì lịch
  retry sống trong RAM là lịch retry bị một lần deploy huỷ im lặng. Retry 30s → ×4 → trần 6h,
  6 lần; 4xx (trừ 408/429) là "đừng gửi nữa" → `dropped`, không phải `failed`. Breaker tắt endpoint
  sau 20 lần hỏng liên tiếp.
- Phát sự kiện ở đúng chỗ: `user.suspended` · `user.reinstated` · `user.offboarded` ·
  `user.password_reset` · `member.joined`. **Luôn phát sau khi đã thu hồi**, không phải trước —
  app con phản ứng bằng cách xoá dữ liệu cục bộ thì không được nghe tin trong lúc token còn sống.
- `POST /api/v1/webhooks` — chỉ nhận khoá `sk_` + scope `admin`; secret trả về **đúng một lần**.
- `POST /api/internal/webhooks/drain` — dùng token nội bộ của nền tảng, so sánh constant-time.
- **T5.20 `security-properties.test.ts`** — 22 test ghép các module lại đúng như đường request,
  chứng minh bốn tính chất: cách ly chéo app (aud sai · kid lạ · chữ ký tráo · issuer khác),
  họ refresh token, không leo thang quyền (`pk_` không bao giờ có `db:write`; `db:*` **không** khớp
  `database:read`; gộp role là phép hợp, không phải nâng cấp), và mặc định từ chối (tài nguyên
  không được nhắc tới → deny, và deny **biên dịch ra SQL không bao giờ đúng**).

**Modified files**
- `packages/core/src/webhook.ts` (new) · `src/index.ts` (edit)
- `packages/db/src/schema/webhooks.ts` (new) · `queries/webhooks.ts` (new)
- `packages/db/src/queries/lifecycle.ts` · `schema/{audit-logs,index}.ts` · `queries/index.ts` (edit)
- `packages/auth/src/recovery.ts` (edit)
- `apps/web/src/lib/webhook-dispatch.ts` (new)
- `apps/web/src/app/api/v1/webhooks/route.ts` · `api/internal/webhooks/drain/route.ts` (new)
- `packages/core/tests/{webhook,security-properties}.test.ts` (new)
- `packages/db/migrations/0008_curved_miek.sql` (new)

**Test status**
- `pnpm build` → PASS (6/6 package, `next build` 18 route)
- `pnpm test`  → PASS (338 passed / 338 — core 273 · adapters 30 · web 15 · sdk 12 · db 8)

**Notes / decisions**
- **Phát sự kiện và gửi đi là hai việc tách rời.** Một sự kiện identity phải được ghi lại bất kể
  server của tenant có sống hay không, và request gây ra nó không được chờ socket của bên thứ ba.
  Nên đường phát chỉ ghi dòng rồi trả về; một lượt drain mới thực sự gửi.
- `verifyWebhook` đặt trong `@infra/core` chứ không phải trong SDK, **cố ý**: như vậy đúng đoạn mã
  mà app con sẽ chạy ở đầu nhận cũng chính là đoạn được test ở đây.
- Chấp nhận nhiều `v1=` trong một header để xoay secret mà không rớt delivery nào.
- Phép kiểm URL là kiểm trên chuỗi, **không resolve DNS** — nên vẫn còn đường DNS rebinding. Đã bù
  bằng việc chặn redirect; muốn chắc hơn thì cho webhook đi qua proxy ghim địa chỉ đã resolve.
  Ghi thành rủi ro **R10**.

**Next task** → **Phase 6** — tự động cấp database qua Neon API + Turso API khi tạo app con.

### 2026-09-13 · v0.4.0-rc.6 · feat(auth): brute-force throttling, breached-password checks and account recovery

**Deliverables**
- `throttle.ts` — đường cong khoá đăng nhập thuần hàm. 5 lần sai đầu miễn phí (gõ nhầm không mất gì),
  sau đó 30s và nhân đôi, **chặn trần 15 phút** — khoá vĩnh viễn chính là một lỗ DoS ai cũng nhắm được
  vào người khác bằng cách cố gõ sai. Bộ đếm tự quên sau 1 giờ im lặng.
  Hai trục đếm: `(IP, email)` cho dò một tài khoản và `IP` cho credential stuffing —
  **không bao giờ đếm theo email đơn lẻ**, vì như thế kẻ tấn công khoá được nạn nhân từ bất kỳ đâu.
- `password.ts` — kiểm mật khẩu đã lộ qua HIBP **k-anonymity**: chỉ gửi 5 ký tự đầu của SHA-1,
  dịch vụ trả về ~800 hậu tố, việc so khớp làm tại chỗ — mật khẩu không bao giờ rời tiến trình.
  Có xử lý `Add-Padding`: bản ghi mồi có count 0 phải đọc là "không tìm thấy", nếu không thì
  padding lại trở thành thứ phân biệt được.
- `recovery.ts` + `opaque-token.ts` — token `rec_` 192 bit, chỉ lưu SHA-256, **sống 15 phút**.
  `invitation.ts` refactor dùng chung một cài đặt để cả hai loại link đều có đúng ba thuộc tính đó.
- `infra_login_attempts` — khoá theo **digest** của (scope, ip, email), nên bảng không chứa email hay
  IP dạng thường: một bản dump của nó không biến thành danh sách ai có tài khoản ở đây.
- `infra_recovery_tokens` — đốt token bằng `UPDATE … WHERE used_at IS NULL RETURNING`, nguyên tử,
  hai lần đổi đồng thời thì đúng một lần thắng.
- `auth-shield.ts` — lớp chắn đặt **trước** Better Auth (không sửa ruột thư viện, nên nâng cấp không vỡ):
  throttle `/sign-in/email`; kiểm mật khẩu ở `/sign-up/email`, `/reset-password`, `/change-password`;
  mọi câu trả lời được đệm về cùng một khoảng thời gian.
- `POST /api/v1/auth/recovery/request` · `…/confirm` — request luôn trả **202 giống hệt nhau**
  dù email có tồn tại hay không, và token **không bao giờ** nằm trong response body.

**Modified files**
- `packages/core/src/{opaque-token,recovery,throttle,password}.ts` (new)
- `packages/core/src/{invitation,index}.ts` (edit)
- `packages/db/src/schema/security.ts` (new) · `schema/{refresh-tokens,audit-logs,index}.ts` (edit)
- `packages/db/src/queries/security.ts` (new) · `queries/index.ts` (edit)
- `packages/auth/src/recovery.ts` (new) · `src/index.ts` (edit)
- `apps/web/src/lib/{auth-shield,recovery-delivery}.ts` (new)
- `apps/web/src/app/api/auth/[...all]/route.ts` (edit)
- `apps/web/src/app/api/v1/auth/recovery/{request,confirm}/route.ts` (new)
- `packages/core/tests/{throttle,password,recovery}.test.ts` (new)
- `packages/db/migrations/0007_odd_cerise.sql` (new)

**Test status**
- `pnpm build` → PASS (6/6 package, `next build` 16 route)
- `pnpm test`  → PASS (293 passed / 293 — core 228 · adapters 30 · web 15 · sdk 12 · db 8)

**Notes / decisions**
- **Hai hướng thất bại ngược nhau, cố ý.** Luật cục bộ (quá ngắn, chứa email) **fail closed** —
  không tốn gì và không phụ thuộc gì. Tra cứu HIBP **fail open** — nếu để nó chặn thì một sự cố của
  bên thứ ba sẽ khoá toàn bộ đăng ký và khôi phục tài khoản của cả nền tảng. `breachCount: null`
  ghi lại rằng lần đó không kiểm được, thay vì giả vờ đã kiểm.
- **Thứ tự trong `completePasswordRecovery` không phải thứ tự hiển nhiên:** xem token còn sống →
  chấm mật khẩu mới → **rồi mới** đốt token. Đốt trước thì người dùng thật chọn nhầm một mật khẩu yếu
  sẽ mất luôn link khôi phục của chính mình.
- **Bước ai cũng quên là bước 5:** sau khi đổi mật khẩu phải thu hồi *mọi* session, refresh token và
  thiết bị đã nhớ. Nếu tài khoản đã bị chiếm, kẻ tấn công đang giữ một session sống — đổi mật khẩu mà
  không thu hồi thì tài khoản "đã khôi phục" vẫn nằm trong tay họ.
- Mật khẩu vẫn do Better Auth băm (`auth.$context.password.hash` + `internalAdapter`), không tự băm —
  chọn thuật toán băm lần thứ hai là chọn sai lần thứ hai.
- Một test đã bắt được lỗi thật: `Khoi-Hoang-2026!` không *literal* chứa `khoi.hoang@example.com`,
  nên phép so khớp thô cho qua. Đã sửa: rút cả hai vế về chỉ chữ và số trước khi so.
- **Chưa có mailer** → link khôi phục hiện chỉ in ra console ở môi trường dev. Ghi thành rủi ro R8.

**Next task** → `T5.19` webhook sự kiện identity cho app con.

### 2026-09-10 · v0.1.4 · feat(adapters): add multi-database engine with resolver, pool and health checks

**Deliverables**
- `types.ts` — hợp đồng `DatabaseAdapter` (query / health / close), bảng ánh xạ provider → dialect,
  ngưỡng health (<300ms healthy, <1500ms degraded), timeout mặc định 10s, pool mặc định 3.
- `postgres.adapter.ts` — dùng chung cho Neon và Supabase; `prepare: false` để tương thích
  pgbouncer của Supabase; tham số luôn bind server-side (`sql.unsafe(text, params)`), không nối chuỗi.
- `libsql.adapter.ts` — Turso; `parseLibsqlConnectionString` tách `authToken` khỏi DSN nên token
  không bị ghi lại ở nơi khác; map row theo tên cột.
- `params.ts` — kiểm tra và chuẩn hoá tham số trước khi chạm driver (bigint → string cho PG;
  boolean → 0/1 và Date → ISO cho LibSQL); kiểu lạ bị từ chối kèm vị trí tham số.
- `timeout.ts` — mọi query có ngân sách thời gian, quá hạn thành `DB_QUERY_TIMEOUT`.
- `pool.ts` — LRU 25 mục + TTL 5 phút, tự đóng adapter khi evict/hết hạn, có `stats()`.
- `resolver.ts` — `appId → adapter`; giải mã connection string **chỉ** lúc cache miss, không bao giờ
  cache plaintext; gộp các miss đồng thời để app nguội chỉ mở đúng một kết nối; `invalidate()` cho
  admin đổi cấu hình.
- `health.ts` — `checkAdapterHealth` biến lỗi driver thành báo cáo thay vì exception,
  `checkManyApps`, `worstStatus`.

**Modified files**
- `packages/adapters/src/{types,params,timeout,postgres.adapter,libsql.adapter,factory,pool,resolver,health,index}.ts` (new)
- `packages/adapters/tests/{fake-adapter,pool,resolver,params,adapters}.test.ts` (new)

**Test status**
- `pnpm build` → **PASS** (5 successful, 5 total)
- `pnpm test`  → **PASS** (75 passed / 75 total — core 37, db 8, adapters 30)

**Notes / decisions**
- `postgres.ParameterOrJSON` không nhận `bigint` → chuyển sang chuỗi trong `toPostgresParams`
  thay vì ép kiểu. Không có `as any` nào trong repo.
- Test resolver khẳng định `decrypt` chỉ được gọi **một lần** cho nhiều lần resolve — bằng chứng
  plaintext không nằm trong cache.
- T3.7/T3.8 (route handler + audit) chuyển sang làm cùng Phase 4 vì cần `apps/web`.

**Next task** → `T1.7` (chờ Neon) hoặc `T4.8` SDK — cả hai đều không chặn nhau.

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

## 6. Risk Register

| # | Rủi ro | Ảnh hưởng | Giảm thiểu |
|---|---|---|---|
| R1 | Free tier giới hạn số kết nối → hết slot | Cao | Pool tối đa 3/tenant, idle eviction 5 phút, dùng pooler của Supabase |
| R2 | Mất `INFRA_MASTER_ENCRYPTION_KEY` | Nghiêm trọng — không giải mã lại được | Sao lưu khoá ngoài repo (password manager), cột `encryption_key_version` sẵn cho rotation |
| R3 | Neon/Supabase tự ngủ đông (cold start) | Trung bình | Health check định kỳ, timeout 10s, hiển thị `degraded` thay vì lỗi |
| R4 | API key `pk_live_` lọt vào bundle client | Cao | Tài liệu SDK ghi rõ "server-only"; kiểm tra origin; scope tối thiểu |
| R5 | Better Auth thay đổi API giữa các version | Trung bình | Pin version chính xác, cô lập trong `packages/auth` |
| R6 | Turso/LibSQL khác biệt phương ngữ SQL với PG | Trung bình | Adapter khai báo `dialect`; SDK không hứa hẹn SQL đa phương ngữ |
| R7 | Thư mục kết nối bị gắn lại → mất file chưa commit | Cao (đã xảy ra 1 lần) | Commit git sớm và thường xuyên; giữ bản sao tài liệu trong phiên trước khi ghi xuống máy |
| R8 | Chưa có mailer → link khôi phục không gửi được ở production | Cao (chặn luồng khôi phục thật) | `deliverRecoveryLink` in ra console ở dev và **log lỗi rõ ràng** ở production thay vì nuốt im lặng; nối transport thật ở Phase 8 |
| R9 | HIBP nằm ngoài allowlist egress → không kiểm được mật khẩu lộ | Trung bình | Fail open có chủ đích; `breachCheckPerformed: false` vào audit để biết lần nào chưa kiểm |
| ~~R11~~ | ~~Rate limit trong bộ nhớ → serverless mỗi instance một bộ đếm~~ | — | **Đã đóng ở v0.7.3**: `infra_rate_limits` là bộ đếm dùng chung; lớp cục bộ chỉ được từ chối (ADR-025) |
| R10 | DNS rebinding: host webhook công khai nhưng resolve về địa chỉ nội bộ | Cao | `isPublicHttpUrl` chặn theo URL + **từ chối redirect**; cần chắc hơn thì egress qua proxy ghim IP đã resolve |
