# Hướng dẫn tạo database — Neon · Supabase · Turso

> Dành cho Khoi. Không cần biết code, chỉ cần copy–paste. Cả ba đều **miễn phí**, không cần thẻ tín dụng.

---

## Hiểu nhanh: hệ thống dùng database thế nào

Có **hai loại** database, đừng nhầm:

| Loại | Bao nhiêu cái | Dùng để làm gì | Khai báo ở đâu |
|---|---|---|---|
| **Master DB** | Đúng **1** cái | Nơi Unified-App-Infra lưu: danh sách app con, API key (đã băm), cấu hình database (đã mã hoá), nhật ký. | File `.env.local`, biến `INFRA_MASTER_DATABASE_URL` |
| **Tenant DB** | **Mỗi app con 1 cái** | Nơi app con lưu dữ liệu của chính nó (ghi chú, bài học, đơn hàng…). | Dán vào Admin Dashboard (Phase 4), hệ thống tự **mã hoá AES-256-GCM** rồi mới lưu |

Vì mỗi app con có database riêng nên dữ liệu không bao giờ lẫn vào nhau. Và vì mỗi nhà cung cấp
đều giới hạn free tier, nên trải app ra nhiều nhà cung cấp = có nhiều "hạn mức miễn phí" hơn.

**Kế hoạch đề xuất:**

```
Master DB          → Neon      (project riêng, tên: infra-master)
App con #1,2,3     → Neon      (mỗi app 1 project)
App con #4,5       → Supabase  (khi Neon hết 10 project miễn phí)
App con nhẹ / edge → Turso     (nhanh, nhiều database nhất)
```

---

## PHẦN 1 — Neon (làm ngay, đây là Master DB)

**Free tier:** 10 project, mỗi project 0.5 GB. Tự ngủ sau vài phút không dùng rồi tự thức lại.

1. Mở **https://neon.com** → bấm **Sign up** → chọn **Continue with GitHub** (hoặc Google).
2. Sau khi đăng nhập, Neon hỏi tạo project đầu tiên:
   - **Project name:** `infra-master`
   - **Postgres version:** để mặc định (bản mới nhất)
   - **Region:** chọn **AWS US East (Ohio)** hoặc region gần Khoi nhất
   - Bấm **Create project**
3. Neon hiện ngay ô **Connection string**. Bấm nút **Copy**. Chuỗi trông như:

   ```
   postgresql://neondb_owner:npg_AbCd1234@ep-cool-name-a1b2c3.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

   > ⚠️ Chuỗi này **là mật khẩu**. Không dán vào chat, không đưa lên GitHub, không gửi cho ai.
   > Nếu lỡ lộ: vào **Settings → Reset password** để đổi.

4. Về máy, mở Terminal:

   ```bash
   cd ~/Documents/AI_system/unified-app-infra
   cp .env.example .env.local
   open -e .env.local
   ```

5. Trong file vừa mở, dán chuỗi vừa copy vào dòng `INFRA_MASTER_DATABASE_URL="..."` (giữ nguyên hai dấu nháy).

6. Sinh hai khoá bí mật:

   ```bash
   echo "INFRA_MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32)"
   echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)"
   ```

   Copy hai dòng in ra, dán đè vào hai dòng tương ứng trong `.env.local`, rồi lưu file (Cmd+S).

   > 🔑 **Sao lưu `INFRA_MASTER_ENCRYPTION_KEY` vào password manager ngay.** Đây là khoá giải mã
   > mọi connection string của app con. Mất khoá = mất hết, không có cách khôi phục.

7. Tạo bảng trên Neon:

   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   cd ~/Documents/AI_system/unified-app-infra
   pnpm db:migrate
   ```

   Thành công sẽ thấy các dòng `applying migration...`. Kiểm tra lại:

   ```bash
   pnpm db:studio      # mở trình duyệt xem 9 bảng vừa tạo
   ```

**Xong Phần 1 = mở khoá task T1.7, Phase 1 hoàn tất.**

---

## PHẦN 2 — Supabase (làm khi cần thêm database cho app con)

**Free tier:** 2 project hoạt động cùng lúc, mỗi project 500 MB. Có sẵn giao diện xem/sửa dữ liệu.

1. Mở **https://supabase.com** → **Start your project** → đăng nhập bằng GitHub.
2. **New project**:
   - **Name:** đặt theo app con, ví dụ `learning-ai-db`
   - **Database Password:** bấm **Generate a password** → **copy và lưu vào password manager ngay**
     (Supabase không cho xem lại)
   - **Region:** chọn gần Khoi
   - **Create new project** → đợi ~2 phút
3. Vào **Project Settings** (bánh răng) → **Database** → mục **Connection string** → chọn tab
   **Transaction pooler** (cổng `6543`, KHÔNG phải `5432`).
4. Copy chuỗi, thay `[YOUR-PASSWORD]` bằng mật khẩu đã lưu ở bước 2:

   ```
   postgresql://postgres.abcdefgh:MẬT_KHẨU@aws-0-us-east-1.pooler.supabase.com:6543/postgres
   ```

   > Vì sao phải dùng pooler cổng 6543? Free tier chỉ cho rất ít kết nối trực tiếp; pooler cho
   > phép nhiều app dùng chung một số ít kết nối thật.

5. Chuỗi này **chưa dán vào file nào cả**. Giữ trong password manager, tới Phase 4 sẽ dán vào
   Admin Dashboard → hệ thống tự mã hoá rồi lưu vào `infra_database_configs`.

---

## PHẦN 3 — Turso (database nhẹ, nhanh, số lượng nhiều)

**Free tier:** 500 database, tổng 5 GB. Kiểu SQLite (gọi là LibSQL) — cực nhanh cho app nhỏ.

1. Mở **https://turso.tech** → **Sign up** bằng GitHub.
2. Cài công cụ dòng lệnh:

   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   turso auth login          # mở trình duyệt để xác nhận
   ```

3. Tạo database cho một app con:

   ```bash
   turso db create agentui-db
   turso db show agentui-db --url        # in ra: libsql://agentui-db-<user>.turso.io
   turso db tokens create agentui-db     # in ra token dài
   ```

4. Ghép hai thứ trên thành một chuỗi kết nối:

   ```
   libsql://agentui-db-minkoi007cs.turso.io?authToken=DÁN_TOKEN_VÀO_ĐÂY
   ```

5. Lưu vào password manager. Tới Phase 4 dán vào Admin Dashboard, chọn provider **Turso**.

---

## Bảng so sánh — chọn cái nào cho app con nào

| | **Neon** | **Supabase** | **Turso** |
|---|---|---|---|
| Loại | PostgreSQL | PostgreSQL | LibSQL (SQLite) |
| Số DB miễn phí | 10 project | 2 project | 500 database |
| Dung lượng | 0.5 GB/project | 500 MB/project | 5 GB tổng |
| Ngủ đông | Có (~5 phút) | Có (7 ngày không dùng) | Không |
| Điểm mạnh | Nhanh, tạo nhánh để test | Có giao diện xem dữ liệu, kèm storage + realtime | Nhiều DB nhất, độ trễ thấp |
| Hợp với | Master DB, app chính | App cần tự xem dữ liệu | App nhỏ, nhiều app |

---

## Quy tắc an toàn (đọc một lần, nhớ mãi)

1. **Không bao giờ** dán connection string hoặc token vào chat, GitHub, hay ảnh chụp màn hình.
2. Mọi mật khẩu/token → lưu **password manager** (iCloud Keychain trên MacBook là đủ).
3. File `.env.local` đã nằm trong `.gitignore` — nó **không** bị đẩy lên GitHub. Đừng đổi điều đó.
4. Connection string của app con **không lưu dạng thường** ở đâu cả: hệ thống mã hoá
   AES-256-GCM rồi mới ghi vào Master DB.
5. Lộ chuỗi kết nối → vào nhà cung cấp đổi mật khẩu (Neon: Reset password · Supabase: Database
   Settings → Reset · Turso: `turso db tokens invalidate <tên-db>`).

---

## Checklist

- [ ] Tạo tài khoản Neon, tạo project `infra-master`
- [ ] Dán `INFRA_MASTER_DATABASE_URL` vào `.env.local`
- [ ] Sinh `INFRA_MASTER_ENCRYPTION_KEY` + `BETTER_AUTH_SECRET`, **sao lưu khoá mã hoá**
- [ ] Chạy `pnpm db:migrate` — thấy 9 bảng
- [ ] (Sau) Tạo tài khoản Supabase khi cần database thứ 2
- [ ] (Sau) Cài Turso CLI khi cần database cho app nhỏ
