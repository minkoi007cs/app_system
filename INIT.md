# INIT.md — Lệnh khởi tạo & vận hành dự án

> Chạy trong Terminal. Bước 0–7 là phần **T1.1 đã chạy xong** (giữ lại để dựng lại từ đầu khi cần);
> phần cuối là lệnh dùng hằng ngày.

---

## Bước 0 — Kiểm tra công cụ

```bash
node -v                                   # cần >= 20 (máy đang dùng v22.23.2)
corepack enable --install-directory "$HOME/.local/bin"
corepack prepare pnpm@9.12.0 --activate
export PATH="$HOME/.local/bin:$PATH"      # ⚠️ mỗi shell mới phải chạy lại dòng này
pnpm -v                                   # 9.12.0
```

## Bước 1 — Vào thư mục dự án & khởi tạo git

```bash
cd ~/Documents/AI_system/unified-app-infra
git init -b main
printf 'node_modules\n.next\ndist\n.turbo\n.env\n.env.local\n*.log\n.DS_Store\ncoverage\n' > .gitignore
echo "22" > .nvmrc
```

## Bước 2 — Cấu trúc workspace

```bash
mkdir -p apps packages/{core,db,adapters,auth,sdk}/src tooling
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`package.json` (gốc) — scripts: `build`, `dev`, `test`, `lint`, `typecheck`, `db:generate`,
`db:migrate`, `db:studio`.
`turbo.json` — task graph: `build` (dependsOn `^build`), `test`, `typecheck`, `lint`, `dev`.
`tsconfig.base.json` — `strict`, `noImplicitAny`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `module: ESNext`, `moduleResolution: Bundler`.

## Bước 3 — Dependency ở gốc repo

```bash
pnpm add -Dw turbo typescript vitest @vitest/coverage-v8 tsx @types/node
```

## Bước 4 — Dependency cho từng package (chạy khi tới task tương ứng)

```bash
# T1.2–T1.4 · @infra/core
pnpm add --filter @infra/core zod

# T1.6 · @infra/db — Master DB (Neon PostgreSQL)
pnpm add --filter @infra/db drizzle-orm postgres
pnpm add -D --filter @infra/db drizzle-kit

# Phase 3 · @infra/adapters
pnpm add --filter @infra/adapters postgres @libsql/client

# Phase 2 · @infra/auth
pnpm add --filter @infra/auth better-auth drizzle-orm
```

## Bước 5 — Next.js 15 (làm ở Phase 4, T4.1)

```bash
pnpm dlx create-next-app@latest apps/web \
  --typescript --tailwind --eslint --app --src-dir \
  --import-alias "@/*" --use-pnpm --skip-install --yes

cd apps/web
pnpm dlx shadcn@latest init -d
pnpm dlx shadcn@latest add button card table dialog input label badge \
  dropdown-menu sonner tabs separator alert form select skeleton
pnpm add lucide-react
cd ../..

pnpm add --filter web "@infra/core@workspace:*" "@infra/db@workspace:*" \
  "@infra/adapters@workspace:*" "@infra/auth@workspace:*"
```

## Bước 6 — Biến môi trường

```bash
cp .env.example .env.local
echo "INFRA_MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)"
```

Chép hai dòng vừa in vào `.env.local`, rồi thêm `INFRA_MASTER_DATABASE_URL` lấy từ Neon.

> ⚠️ **Sao lưu `INFRA_MASTER_ENCRYPTION_KEY` vào password manager.** Mất khoá này là mất toàn
> bộ connection string đã mã hoá — không có cách khôi phục (rủi ro R2 trong `process.md`).

## Bước 7 — Kiểm tra

```bash
pnpm install && pnpm build && pnpm test
```

Cả hai lệnh cuối phải PASS trước khi ghi entry mới vào `process.md`.

---

## Lệnh dùng hằng ngày

```bash
export PATH="$HOME/.local/bin:$PATH"
cd ~/Documents/AI_system/unified-app-infra

pnpm build          # biên dịch toàn bộ package
pnpm test           # chạy vitest toàn repo
pnpm typecheck      # kiểm tra kiểu, không xuất file
pnpm db:generate    # sinh migration Drizzle từ schema
pnpm db:migrate     # đẩy migration lên Master DB
pnpm db:studio      # mở Drizzle Studio xem dữ liệu
```
