# Runbooks

> Việc vận hành, viết ra để lúc cần không phải nghĩ. Mỗi mục có **điều kiện dừng** — chỗ mà nếu
> thấy dấu hiệu đó thì dừng lại chứ không đi tiếp.

---

## 1. Lịch chạy định kỳ (bắt buộc trước khi có người dùng thật)

Hai endpoint nội bộ **không tự chạy**. Không ai gọi thì webhook xếp hàng mãi và session mạo danh đã
hết giờ vẫn đọc như đang mở.

| Endpoint | Tần suất | Làm gì |
|---|---|---|
| `POST /api/internal/webhooks/drain` | mỗi phút | Gửi các delivery tới hạn, tối đa 25 mỗi lượt |
| `POST /api/internal/maintenance` | mỗi giờ | Dọn bộ đếm đăng nhập, đóng session mạo danh quá hạn, xoá delivery đã xong > 14 ngày, xả decision log |

Cả hai đều dùng `INFRA_INTERNAL_TOKEN`, so sánh constant-time. **Chưa đặt biến này thì không ai qua
được** — cửa đóng, không phải cửa mở. Sinh token:

```
openssl rand -base64 48
```

Thêm vào `.env.local` (và vào biến môi trường của nơi deploy):

```
INFRA_INTERNAL_TOKEN="<chuỗi vừa sinh>"
```

### Gọi bằng cron trên máy tự host

Một lệnh, idempotent, chạy lại không nhân đôi dòng:

```
./scripts/install-cron.sh
```

Trỏ vào host khác thì truyền URL: `./scripts/install-cron.sh https://infra.example.com`.
Gỡ: `./scripts/install-cron.sh --remove`. Xem lại: `crontab -l | grep unified-app-infra`.

Script đặt token vào `~/.config/unified-app-infra/internal-token` quyền 600 và để dòng cron `cat`
file đó, **chứ không nhúng token vào crontab**: crontab là file văn bản thường, và một lệnh `ps`
đúng lúc cũng đọc được dòng lệnh đang chạy.

Dòng cron dùng `curl -fsS`. `-f` để curl trả mã lỗi khi HTTP 4xx/5xx — nếu không, cron sẽ im lặng
coi mọi lần 401 là thành công, và đó đúng là kiểu hỏng mà lịch chạy sinh ra để tránh. stderr đi vào
`~/.local/state/unified-app-infra/`, nên một endpoint hỏng còn để lại dấu vết.

### Gọi bằng Vercel Cron

`vercel.json` ở gốc repo **đã khai báo sẵn** hai lịch này — deploy lên Vercel là có, không phải làm gì
thêm. Việc duy nhất còn lại: Vercel Cron gửi header `Authorization: Bearer <CRON_SECRET>`, nên đặt
`INFRA_INTERNAL_TOKEN` **bằng đúng** `CRON_SECRET` trong biến môi trường của project.

**Điều kiện dừng:** nếu drain trả `attempted > 0` mà `delivered = 0` liên tục nhiều lượt, endpoint
của tenant đang hỏng chứ không phải hệ thống — xem `infra_webhook_deliveries.last_error`, và nhớ
breaker sẽ tự tắt endpoint sau 20 lần hỏng liên tiếp.

---

## 2. Xoay `INFRA_MASTER_ENCRYPTION_KEY`

Khoá này giải mã **mọi** bí mật của hệ thống. Mất là mất hết, không có đường khôi phục (rủi ro R2).
Xoay nó là thao tác nguy hiểm nhất trong toàn hệ thống.

**Bốn bảng mang ciphertext, không phải một.** Phiên bản trước của runbook này chỉ dặn kiểm tra
health của app sau khi xoay — tức là chỉ kiểm một trong bốn:

| Bảng | Nội dung | Hỏng thì sao |
|---|---|---|
| `infra_database_configs` | connection string của app con | app con mất đường tới database |
| `infra_signing_keys` | private key ES256 | không ký được JWT nào nữa — mọi đăng nhập chết |
| `infra_webhook_endpoints` | secret ký webhook | app con từ chối mọi webhook vì chữ ký sai |
| `infra_mfa_factors` | seed TOTP | người đã bật MFA bị khoá ngoài tài khoản của chính họ |

**Công cụ:** `scripts/rotate-master-key.mjs`. Nó giải mã từng dòng bằng khoá của phiên bản đang lưu
trên chính dòng đó, mã hoá lại bằng khoá mới, **giữ nguyên AAD** (AAD buộc ciphertext vào đúng dòng
sở hữu nó — khoá đổi, ngữ cảnh thì không), rồi nâng `encryption_key_version`.

> `scripts/rotate-encryption-key.py` **không** xoay khoá. Nó chỉ điền khoá lần đầu vào `.env.local`
> và giờ đã từ chối ghi đè một khoá hợp lệ. Chạy nó trên hệ thống đã có dữ liệu là mất sạch.

### Cách đánh số phiên bản

Khoá **cộng thêm về phía trước**, không bao giờ tráo chỗ cho nhau:

```
INFRA_MASTER_ENCRYPTION_KEY           khoá phiên bản 1   ← GIỮ NGUYÊN
INFRA_MASTER_ENCRYPTION_KEY_V2        khoá phiên bản 2   ← khoá mới vào đây
INFRA_MASTER_ENCRYPTION_KEY_VERSION   phiên bản dùng để GHI dòng mới
```

**Đừng bao giờ đặt khoá mới vào `INFRA_MASTER_ENCRYPTION_KEY`.** Mọi dòng đang mang
`encryption_key_version = 1` sẽ đi tìm khoá cũ ở đó, gặp khoá mới, và không mở được gì cả.

`INFRA_MASTER_ENCRYPTION_KEY_VERSION` là bước kết. Chưa đặt thì dòng **mới** — một database config
vừa thêm trong dashboard, một khoá ký vừa xoay — vẫn được ghi bằng khoá cũ, và vòng xoay không bao
giờ kết thúc được: khoá cũ vĩnh viễn vẫn cần thiết.

### Diễn tập

Bài diễn tập này **đã được chạy** ngày 2026-09-14 trên Postgres 16 cục bộ với đúng schema thật
(31 bảng từ migration 0000→0011), 9 dòng ciphertext trên cả bốn bảng, xoay 1→2 rồi 2→3. Nó bắt
được một lỗi thật trong chính công cụ (AAD của `infra_signing_keys` dựng từ một cột mà câu select
đã đặt bí danh mất) — đó là lý do diễn tập tồn tại. Log: `logs/rotate-*.log`.

Chạy lại bài đó bất cứ lúc nào, trên một database vứt đi:

```
createdb infra_drill
```

```
export INFRA_MASTER_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/infra_drill?sslmode=disable"
```

```
pnpm db:migrate
```

```
export INFRA_MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

```
node scripts/drill-seed.mjs
```

```
export INFRA_MASTER_ENCRYPTION_KEY_V2=$(openssl rand -hex 32)
```

```
node scripts/rotate-master-key.mjs --to 2 --dry-run
```

```
node scripts/rotate-master-key.mjs --to 2
```

```
DRILL_OLD_KEY=$INFRA_MASTER_ENCRYPTION_KEY DRILL_NEW_KEY=$INFRA_MASTER_ENCRYPTION_KEY_V2 node scripts/drill-verify.mjs
```

`drill-verify.mjs` không tin báo cáo của công cụ xoay: nó mở lại từng dòng bằng khoá mới **và** xác
nhận khoá cũ không còn mở được dòng nào. Một vòng xoay mà khoá cũ vẫn mở được nghĩa là chưa xoay
thật, chỉ ghi đè số phiên bản.

`drill-seed.mjs` và `drill-verify.mjs` từ chối chạy nếu DSN không phải localhost và không có chữ
`drill` trong tên — chúng ghi vào bốn bảng nhạy cảm nhất của hệ thống.

### Xoay thật

1. **Sao lưu khoá cũ vào password manager trước.** Không có nó thì không rollback được.
2. Sinh khoá mới: `openssl rand -hex 32`
3. Đặt nó vào `INFRA_MASTER_ENCRYPTION_KEY_V2`. **Giữ nguyên** khoá cũ ở `INFRA_MASTER_ENCRYPTION_KEY`.
4. `node scripts/rotate-master-key.mjs --to 2 --dry-run` — xem nó mở được bao nhiêu dòng. Còn
   dòng nào FAIL thì dừng ở đây; chưa ghi gì cả.
5. `node scripts/rotate-master-key.mjs --to 2` — ghi thật, từng dòng một, mỗi dòng một UPDATE.
6. Đặt `INFRA_MASTER_ENCRYPTION_KEY_VERSION=2`, khởi động lại ứng dụng.
7. Health check **mọi** app trong Dashboard, **và** đăng nhập thử một tài khoản có MFA, **và** gửi
   thử một webhook. Ba thứ, không phải một.
8. Chỉ khi tất cả xanh mới gỡ khoá cũ khỏi môi trường.

**Điều kiện dừng:** thấy bất kỳ dòng FAIL nào ở bước 4 hoặc 5, hoặc bất kỳ `CRYPTO_DECRYPT_FAILED`
nào ở bước 7 thì **dừng, giữ nguyên khoá cũ trong môi trường**, và điều tra. Gỡ khoá cũ lúc này là
biến một lỗi sửa được thành mất dữ liệu vĩnh viễn. Công cụ chạy lại được: nó bỏ qua dòng đã ở
phiên bản đích, nên chạy lại sau khi sửa là an toàn.

---

## 3. Sao lưu và khôi phục Master DB

Mất Master DB = mất mọi cấu hình app con, mọi khoá đã băm, mọi policy. Dữ liệu của app con nằm ở
database riêng của chúng nên vẫn còn — nhưng **không ai giải mã được connection string để tới đó**.

1. Bật **Point-in-time restore** trên project Neon của Master DB (free tier có, giữ 7 ngày).
2. **Thử khôi phục một lần.** Tạo branch từ một thời điểm 1 giờ trước, rồi trỏ `verify:live` vào
   branch đó — biến môi trường thắng `.env.local`, nên không cần sửa file nào:

   ```
   INFRA_MASTER_DATABASE_URL="<dsn của branch>" pnpm verify:live
   ```

   Phải ra **31 bảng** và **12 migration đã ghi nhận**. Log tự ghi vào `logs/`, đã che dữ liệu nhạy cảm.
3. Ghi lại mất bao lâu. Con số đó là RTO thật, không phải con số đoán.

**Backup chưa thử khôi phục thì chưa phải backup** — nó chỉ là một niềm tin.

---

## 4. Có người báo tài khoản bị chiếm

1. Đình chỉ ngay: Dashboard → app → tìm user → **Suspend**. Việc này thu hồi refresh token và xoá
   session, nhưng **giữ lại role** để hoàn tác được.
2. Kiểm `infra_audit_logs` lọc theo `actor_id` của họ: tìm `auth.signin`, `auth.token.refreshed`, và
   đặc biệt **`auth.token.reuse_detected`** — dòng đó nghĩa là một refresh token đã bị phát lại,
   tức là có bản sao credential ở đâu đó.
3. Kiểm `infra_impersonation_sessions` lọc theo `target_user_id` — loại trừ khả năng đó thực ra là
   một phiên hỗ trợ hợp lệ.
4. Kiểm `infra_trusted_devices`: thiết bị lạ nào được nhớ trong khoảng thời gian đó?
5. Cho họ đặt lại mật khẩu. `completePasswordRecovery` tự thu hồi **mọi** session, refresh token và
   thiết bị đã nhớ — bước này không cần làm tay.
6. Reinstate.

**Điều kiện dừng:** nếu thấy `auth.token.reuse_detected` mà người dùng nói họ không làm gì bất
thường, **đừng vội kết luận là tấn công**. Kiểm xem app con của họ có đang dùng SDK cũ không có gộp
refresh single-flight hay không (ADR-018) — năm request song song cũng sinh ra đúng dấu hiệu này.

---

## 5. Một app con đọc không ra dữ liệu

Gần như luôn là **mặc định từ chối đang hoạt động đúng**, không phải lỗi.

1. Mở `/apps/<id>/access`. Không có policy nào → đó là câu trả lời. Trang đã nói thẳng điều đó.
2. Có policy rồi thì đọc cột **"Compiles to"**. Điều kiện đó có khớp với dữ liệu thật trong bảng
   không? Ví dụ hay gặp: policy lọc `owner_id = :current_user` trong khi bảng đặt tên cột là
   `user_id`.
3. Kiểm role: người đó có `<bảng>:read` chưa? Thiếu RBAC thì ABAC không bao giờ được chạy tới.
4. Mở `/audit`, lọc `access.denied`. Trường `deniedBy` nói rõ tầng nào từ chối: `rbac` hay `abac`.

---

## 6. Trước khi deploy lên môi trường nhiều instance

Đọc R11 và ADR-011 trước. `apps/web/src/lib/rate-limit.ts` đếm **trong bộ nhớ tiến trình**, nên trên
serverless mỗi instance có một bộ đếm riêng và hạn mức `/api/v1/*` bị nhân lên theo số instance.

Chống dò mật khẩu **không** dính, vì `infra_login_attempts` nằm trong database.

Cần chạy nhiều instance thì thay `lib/rate-limit.ts` bằng một store dùng chung trước khi mở cho
người dùng thật.
