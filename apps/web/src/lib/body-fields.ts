/**
 * Đọc một trường body nhận cả `snake_case` lẫn `camelCase`.
 *
 * Vì sao cần: ba endpoint xác thực không nhất quán với nhau. `/api/v1/auth/token` đọc
 * `grant_type` — đúng quy ước OAuth 2.0, và đúng thứ một người từng tích hợp OAuth sẽ gửi.
 * `/refresh` và `/revoke` đọc `refreshToken` — đúng quy ước phần còn lại của API này, và đúng thứ
 * `@infra/sdk` gửi.
 *
 * Cả hai lựa chọn đều có lý. Cái không có lý là **bắt người tích hợp phải nhớ endpoint nào theo
 * quy ước nào**, khi gửi sai dạng thì lỗi trả về là `VALIDATION_FAILED: refreshToken is required`
 * trong lúc họ đang nhìn vào một body có `refresh_token` nằm ngay đó.
 *
 * Nên nhận cả hai, ở cả ba endpoint. Không bỏ dạng nào: bỏ `grant_type` là phá hợp đồng OAuth và
 * phá mọi client đang chạy; bỏ `refreshToken` là phá SDK của chính dự án.
 *
 * `camelCase` **thắng** khi cả hai cùng có mặt, để dạng chính tắc của API này là dạng quyết định,
 * và để hành vi là xác định thay vì phụ thuộc thứ tự khoá trong JSON.
 */

/** `refreshToken` → `refresh_token`. Chỉ xử lý định danh ASCII, đủ cho tên trường. */
export function toSnakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

/**
 * Đọc một trường chuỗi không rỗng theo cả hai quy ước. Trả `null` khi thiếu hoặc không phải chuỗi
 * — phía gọi quyết định đó là lỗi hay là tuỳ chọn.
 */
export function stringField(body: unknown, camelName: string): string | null {
  if (body === null || typeof body !== 'object') return null;

  const record = body as Record<string, unknown>;
  const snakeName = toSnakeCase(camelName);

  for (const name of [camelName, snakeName]) {
    const value = record[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Như trên, cho cờ boolean. `allSessions` / `all_sessions`. */
export function booleanField(body: unknown, camelName: string): boolean {
  if (body === null || typeof body !== 'object') return false;

  const record = body as Record<string, unknown>;
  for (const name of [camelName, toSnakeCase(camelName)]) {
    if (record[name] === true) return true;
  }
  return false;
}
