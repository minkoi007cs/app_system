# notes-app — bằng chứng tích hợp dưới 10 dòng

App con nhỏ nhất có thể, dùng Unified-App-Infra làm backend. Không có framework, không có build
step — chỉ Node và `@infra/sdk`, để thứ được chứng minh là **nền tảng**, không phải công sức dựng app.

Trỏ sang một app thật (AI Study OS) chỉ là đổi `APP_SLUG` và bảng trong `setup.mts`.

---

## Trình duyệt — khoá công khai, luật áp phía server

```ts
import { createInfraClient } from '@infra/sdk';

const infra = createInfraClient({ baseUrl: process.env.INFRA_URL!, apiKey: 'pk_live_…' });

const { data, error } = await infra
  .from('notes')
  .select('id', 'title', 'created_at')
  .eq('done', false)
  .order('created_at', 'desc')
  .limit(20)
  .execute();
```

Chín dòng. Khoá `pk_` nằm trong bundle trình duyệt — **công khai theo thiết kế**, và điều đó an toàn
vì người gọi không viết được SQL tuỳ ý và không thoát được bộ lọc dòng: server dựng câu lệnh, và
điều kiện policy được AND vào bởi chính lệnh dựng ra nó.

Người dùng chỉ thấy note của **chính họ**, không phải vì câu truy vấn trên nói thế — nó không hề
nhắc tới `owner_id` — mà vì policy ở hub nói thế.

## Server — khoá bí mật, token theo từng request

```ts
import { createServerClient } from '@infra/sdk';

export async function loadNotes(cookieJar) {
  const infra = createServerClient({
    baseUrl: process.env.INFRA_URL!,
    apiKey: process.env.INFRA_SECRET_KEY!,
    storage: cookieJar,          // bắt buộc: token của request này nằm ở đây
  });

  return infra.from('notes').select('id', 'title').rowsOnly();
}
```

`storage` là **bắt buộc**, và đó là điểm mấu chốt: cùng một tiến trình phục vụ hàng nghìn người,
nên bất kỳ token nào sống lâu hơn một request đều là rò rỉ chéo người dùng. Refresh token tự xoay
và được gộp single-flight, nên năm request song song không làm reuse detection đăng xuất người dùng.

---

## Chạy thật

```bash
export INFRA_URL="http://localhost:3000"
export INFRA_MASTER_DATABASE_URL="…"        # cùng Master DB mà hub đang dùng
export INFRA_MASTER_ENCRYPTION_KEY="…"
pnpm --filter @infra/example-notes setup
```

`setup.mts` làm đúng những việc một người sẽ làm bằng tay trong Dashboard:

1. đăng ký app con `notes-app`
2. cấp một khoá `pk_` (trình duyệt) và một khoá `sk_` (server)
3. tạo bảng `notes` trong database của app đó
4. **viết bốn policy** — mỗi người chỉ thấy/sửa/xoá note của chính mình

Bước 4 mới là bước quan trọng: bỏ nó đi thì app không đọc được gì cả. Mặc định là từ chối, và điều
đó cố ý gây khó chịu — một nền tảng mà app mới đọc được mọi thứ cho tới khi ai đó nhớ ra phải khoá
lại là một nền tảng rò rỉ dữ liệu ngay ngày đầu.

Rồi chạy thử:

```bash
pnpm --filter @infra/example-notes demo
```
