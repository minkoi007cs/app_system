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

```
* * * * * curl -fsS -X POST -H "Authorization: Bearer $INFRA_INTERNAL_TOKEN" http://localhost:3000/api/internal/webhooks/drain >/dev/null
```

```
0 * * * * curl -fsS -X POST -H "Authorization: Bearer $INFRA_INTERNAL_TOKEN" http://localhost:3000/api/internal/maintenance >/dev/null
```

`-f` để curl trả mã lỗi khi HTTP 4xx/5xx — nếu không, cron sẽ im lặng coi mọi lần 401 là thành công,
và đó đúng là kiểu hỏng mà lịch chạy sinh ra để tránh.

### Gọi bằng Vercel Cron

`vercel.json`:

```json
{
  "crons": [
    { "path": "/api/internal/webhooks/drain", "schedule": "* * * * *" },
    { "path": "/api/internal/maintenance", "schedule": "0 * * * *" }
  ]
}
```

Vercel Cron gửi header `Authorization: Bearer <CRON_SECRET>`, nên đặt `INFRA_INTERNAL_TOKEN` **bằng
đúng** `CRON_SECRET`.

**Điều kiện dừng:** nếu drain trả `attempted > 0` mà `delivered = 0` liên tục nhiều lượt, endpoint
của tenant đang hỏng chứ không phải hệ thống — xem `infra_webhook_deliveries.last_error`, và nhớ
breaker sẽ tự tắt endpoint sau 20 lần hỏng liên tiếp.

---

## 2. Xoay `INFRA_MASTER_ENCRYPTION_KEY`

Khoá này giải mã **mọi** connection string của app con. Mất là mất hết, không có đường khôi phục
(rủi ro R2). Xoay nó là thao tác nguy hiểm nhất trong toàn hệ thống, nên phần quan trọng nhất của
runbook này là **diễn tập trước khi cần**.

### Diễn tập (làm một lần, ngay bây giờ, trên bản sao)

1. Tạo một Neon branch từ Master DB — đây là bản sao để phá.
2. Trỏ `INFRA_MASTER_DATABASE_URL` vào branch đó trong một `.env.drill` riêng.
3. Chạy `scripts/rotate-encryption-key.py` với `--dry-run`, xem nó báo sẽ chạm bao nhiêu dòng.
4. Chạy thật trên branch. Rồi `pnpm db:studio` và mở một app, bấm health check — **phải xanh**.
5. Xoá branch.

Chưa diễn tập thì **chưa được xoay trên Master DB thật**. Một quy trình chưa ai chạy bao giờ không
phải là quy trình, nó là một ý tưởng.

### Xoay thật

1. **Sao lưu khoá cũ vào password manager trước.** Không có nó thì không rollback được.
2. Sinh khoá mới: `openssl rand -hex 32`
3. Đặt **cả hai** vào môi trường: khoá mới ở `INFRA_MASTER_ENCRYPTION_KEY`, khoá cũ ở
   `INFRA_MASTER_ENCRYPTION_KEY_V1` (cột `encryption_key_version` cho phép giải mã lẫn lộn trong lúc
   chuyển).
4. Chạy `scripts/rotate-encryption-key.py`.
5. Health check **mọi** app trong Dashboard. Một app đỏ nghĩa là dòng đó chưa xoay xong.
6. Chỉ khi tất cả xanh mới gỡ khoá cũ khỏi môi trường.

**Điều kiện dừng:** thấy bất kỳ lỗi `CRYPTO_DECRYPT_FAILED` nào ở bước 5 thì **dừng, giữ nguyên khoá
cũ trong môi trường**, và điều tra. Gỡ khoá cũ lúc này là biến một lỗi sửa được thành mất dữ liệu.

---

## 3. Sao lưu và khôi phục Master DB

Mất Master DB = mất mọi cấu hình app con, mọi khoá đã băm, mọi policy. Dữ liệu của app con nằm ở
database riêng của chúng nên vẫn còn — nhưng **không ai giải mã được connection string để tới đó**.

1. Bật **Point-in-time restore** trên project Neon của Master DB (free tier có, giữ 7 ngày).
2. **Thử khôi phục một lần.** Tạo branch từ một thời điểm 1 giờ trước, trỏ `.env.drill` vào đó, chạy
   `pnpm db:studio`, đếm đủ 25 bảng.
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
