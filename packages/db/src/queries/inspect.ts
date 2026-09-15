/**
 * Đọc trạng thái thật của Master DB, cho script kiểm tra.
 *
 * Nằm ở đây chứ không nằm trong `scripts/` vì ADR-009: **mọi truy vấn Drizzle sống trong
 * `@infra/db`**. Một script ở gốc repo import thẳng `drizzle-orm` sẽ không resolve được — gói đó
 * không phải dependency của gốc — và quan trọng hơn, nó sẽ là chỗ thứ hai trong dự án nói chuyện
 * trực tiếp với ORM.
 *
 * Không hàm nào ở đây trả về *nội dung* của một dòng. Chỉ tên bảng và số đếm.
 */
import { getTableColumns, is, sql, Table } from 'drizzle-orm';
import { schema, type MasterDatabase } from '../client.js';

/** Chỉ nhận định danh đơn giản — số đếm dưới kia nội suy tên bảng vào câu lệnh. */
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export async function listPublicTables(db: MasterDatabase): Promise<string[]> {
  const rows = (await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
  )) as unknown as Array<{ table_name: string }>;

  return rows.map((row) => row.table_name);
}

/** Số migration Drizzle đã ghi nhận. Null khi chưa migrate lần nào. */
export async function countAppliedMigrations(db: MasterDatabase): Promise<number | null> {
  try {
    const rows = (await db.execute(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? null;
  } catch {
    return null;
  }
}

/** Đếm dòng của một bảng. Trả null nếu tên bảng không hợp lệ hoặc không đọc được. */
export async function countRows(db: MasterDatabase, table: string): Promise<number | null> {
  if (!TABLE_NAME_PATTERN.test(table)) return null;

  try {
    const rows = (await db.execute(
      sql`select count(*)::int as n from ${sql.identifier(table)}`,
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? null;
  } catch {
    return null;
  }
}

/**
 * Các **property key** của một bảng trong đối tượng schema — không phải tên cột trong database.
 *
 * Phân biệt này nghe như chi tiết vặt nhưng đã làm sập hoàn toàn đăng nhập email/mật khẩu ngày
 * 2026-09-15. Drizzle adapter của Better Auth tra cột bằng property key (`activeAppId`), còn cấu
 * hình lại nói với nó tên cột trong database (`active_app_id`). Không khớp → adapter từ chối khởi
 * động → `signInEmail` ném lỗi → endpoint trả 401 "invalid email or password", giống hệt gõ sai
 * mật khẩu.
 *
 * Nằm ở đây theo ADR-009: `drizzle-orm` không phải dependency của `@infra/auth`, và không nên là.
 * Trả về `null` khi không có bảng nào được export dưới khoá đó, để phía gọi phân biệt được "bảng
 * không tồn tại" với "bảng không có cột nào".
 */
export function tableColumnKeys(model: string): string[] | null {
  const table = (schema as unknown as Record<string, unknown>)[model];
  if (table === undefined || !is(table, Table)) return null;
  return Object.keys(getTableColumns(table));
}
