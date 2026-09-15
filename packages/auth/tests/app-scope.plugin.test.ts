/**
 * Hàng rào cho một lỗi đã từng làm **sập hoàn toàn đăng nhập email/mật khẩu** mà không ai thấy.
 *
 * Bối cảnh (2026-09-15): plugin khai báo `fieldName: 'active_app_id'` cho trường `activeAppId`.
 * Nghe hợp lý — đó đúng là tên cột trong database. Nhưng Drizzle adapter của Better Auth định địa
 * chỉ cột bằng **tên property của đối tượng Drizzle**, không phải tên cột trong database. Chính
 * schema check của nó viết: "each column by its property name".
 *
 * Schema của dự án là `activeAppId: uuid('active_app_id')` → property key là `activeAppId`.
 * Better Auth đi tìm một property tên `active_app_id`, không có, và **từ chối khởi động**:
 * `SCHEMA_MISMATCH · missing-column session.active_app_id`. Cột đó tồn tại trong cả database lẫn
 * schema Drizzle. Không có gì bị đặt tên sai — chỉ có hai tầng không đồng ý với nhau về việc đang
 * tra tên nào.
 *
 * Và hậu quả bị **cải trang**: `signInEmail` ném lỗi, `/api/v1/auth/token` bắt mọi lỗi từ nó rồi
 * trả 401 "invalid email or password" — cố ý, để email lạ và mật khẩu sai không phân biệt được.
 * Nên một sự cố toàn phần lại trông y như người dùng gõ sai mật khẩu.
 *
 * Bất biến mà file này giữ: **mọi trường plugin khai báo phải tồn tại như một property key trên
 * đối tượng bảng Drizzle tương ứng** — chính là cách adapter tra nó. Không cần database.
 */
import { describe, expect, it } from 'vitest';
import { tableColumnKeys } from '@infra/db';
import { appScopePlugin } from '../src/app-scope.plugin.js';

type PluginField = { fieldName?: string };
type PluginModel = { fields: Record<string, PluginField> };

const plugin = appScopePlugin();
const pluginSchema = (plugin.schema ?? {}) as Record<string, PluginModel>;

describe('appScopePlugin schema', () => {
  it('khai báo ít nhất một trường — nếu không thì test này vô nghĩa', () => {
    const models = Object.keys(pluginSchema);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(Object.keys(pluginSchema[model]?.fields ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('mỗi model plugin chạm tới phải có một bảng Drizzle cùng khoá export', () => {
    // Adapter tra bảng bằng khoá mà nó được export dưới, đúng như tra cột.
    for (const model of Object.keys(pluginSchema)) {
      expect(tableColumnKeys(model), `không có bảng nào được export dưới khoá "${model}"`).not.toBeNull();
    }
  });

  it('mọi trường plugin tồn tại như PROPERTY KEY trên bảng Drizzle', () => {
    for (const [model, definition] of Object.entries(pluginSchema)) {
      const keys = tableColumnKeys(model);
      if (keys === null) throw new Error(`không có bảng "${model}"`);
      const columnKeys = new Set(keys);

      for (const [key, field] of Object.entries(definition.fields)) {
        // Đây chính là phép tra mà adapter thực hiện: `field.fieldName || key`.
        const addressed = field.fieldName ?? key;
        expect(
          columnKeys.has(addressed),
          `Better Auth sẽ tra "${model}.${addressed}" nhưng bảng Drizzle chỉ có: ` +
            `${[...columnKeys].join(', ')}. ` +
            `Đặt fieldName bằng tên cột trong database là sai — adapter tra theo property key. ` +
            `Bỏ fieldName đi, hoặc đổi nó thành đúng property key.`,
        ).toBe(true);
      }
    }
  });

  it('không trường nào đặt fieldName bằng tên cột snake_case của chính nó', () => {
    // Khẳng định hẹp hơn và thẳng vào chỗ đã sai: nếu một fieldName trông như phiên bản snake_case
    // của khoá, gần như chắc chắn ai đó vừa lặp lại đúng lỗi cũ.
    for (const definition of Object.values(pluginSchema)) {
      for (const [key, field] of Object.entries(definition.fields)) {
        if (field.fieldName === undefined) continue;
        const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        expect(
          field.fieldName,
          `fieldName "${field.fieldName}" đúng là dạng snake_case của "${key}" — ` +
            `đó là lỗi đã làm sập đăng nhập. Drizzle đã sở hữu việc đặt tên cột rồi.`,
        ).not.toBe(snake);
      }
    }
  });
});
