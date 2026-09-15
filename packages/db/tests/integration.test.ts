/**
 * Những thứ chỉ một Postgres thật mới bắt được.
 *
 * Bộ test còn lại của repo chạy không cần database — cố ý, và nó giữ CI nhanh và không cần
 * secret. Nhưng ngày 2026-09-14 việc gọi thử `/api/internal/maintenance` trên một Postgres cục bộ
 * phát hiện hai hàm **chưa từng chạy được lần nào**, trong khi 518 test đều xanh:
 *
 *   `expireImpersonations`  — phiên mạo danh hết hạn không bao giờ bị đóng
 *   `consumeShared`         — bộ đếm rate limit dùng chung không bao giờ ghi được
 *
 * Cả hai hỏng vì cùng một lý do: một `Date` nội suy vào template `sql` thô đi thẳng tới driver,
 * **không qua type mapper của cột**, nên tới Postgres dưới dạng `Mon Sep 14 2026 06:39:44
 * GMT+0000 (Coordinated Universal Time)` — chuỗi mà Postgres không parse được thành timestamptz.
 * Câu lệnh ném lỗi mọi lần chạy.
 *
 * Không có test nào bắt được, vì không có test nào chạm tới một Postgres thật. Và `consumeShared`
 * **fail open** theo thiết kế, nên trên production nó sẽ trông y như đang hoạt động: mọi request
 * được cho qua, không log lỗi nào ở tầng gọi. Đúng loại lỗi tệ nhất — loại trông như đang chạy.
 *
 * File này là hàng rào để nó không quay lại. Bỏ qua khi không có database, nên `pnpm test` trên
 * máy trống vẫn xanh:
 *
 *   INFRA_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/infra_test?sslmode=disable" pnpm test
 *
 * Database chỉ định sẽ bị **ghi vào**. Dùng database vứt đi.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { masterDb, type MasterDatabase } from '../src/client.js';
import { consumeShared, sweepRateLimits } from '../src/queries/rate-limits.js';
import { expireImpersonations } from '../src/queries/impersonation.js';
import { infraImpersonationSessions } from '../src/schema/impersonation.js';
import { infraApps } from '../src/schema/apps.js';
import { user } from '../src/schema/auth.js';
import { eq } from 'drizzle-orm';

const url = process.env['INFRA_TEST_DATABASE_URL'] ?? '';
const enabled = url !== '';

// `describe.skipIf` chứ không phải bỏ file: một test bị bỏ qua vẫn hiện ra trong báo cáo, nên
// không ai nhầm "không chạy" với "đã chạy và xanh".
describe.skipIf(!enabled)('integration · Postgres thật', () => {
  let db: MasterDatabase;
  const madeUsers: string[] = [];
  const madeApps: string[] = [];

  beforeAll(() => {
    process.env['INFRA_MASTER_DATABASE_URL'] = url;
    db = masterDb();
  });

  afterAll(async () => {
    for (const id of madeApps) await db.delete(infraApps).where(eq(infraApps.id, id));
    for (const id of madeUsers) await db.delete(user).where(eq(user.id, id));
  });

  describe('consumeShared', () => {
    it('ghi được vào Postgres thật — câu upsert phải parse được', async () => {
      // Khẳng định nhỏ nhất, và là khẳng định mà bản cũ trượt: câu lệnh chạy được.
      const verdict = await consumeShared(db, `probe-${randomUUID()}`, 10, 60_000, new Date());
      expect(verdict.allowed).toBe(true);
      expect(verdict.remaining).toBe(9);
    });

    it('đếm lên qua từng lượt trong cùng một cửa sổ', async () => {
      const identity = `count-${randomUUID()}`;
      const now = new Date();

      const first = await consumeShared(db, identity, 3, 60_000, now);
      const second = await consumeShared(db, identity, 3, 60_000, now);
      const third = await consumeShared(db, identity, 3, 60_000, now);
      const fourth = await consumeShared(db, identity, 3, 60_000, now);

      expect([first.remaining, second.remaining, third.remaining]).toEqual([2, 1, 0]);
      expect(fourth.allowed).toBe(false);
    });

    it('mở lại cửa sổ khi cửa sổ cũ đã đóng, chứ không đếm tiếp mãi', async () => {
      const identity = `window-${randomUUID()}`;
      const start = new Date();

      await consumeShared(db, identity, 2, 1_000, start);
      await consumeShared(db, identity, 2, 1_000, start);
      const overLimit = await consumeShared(db, identity, 2, 1_000, start);
      expect(overLimit.allowed).toBe(false);

      // Cùng identity, cửa sổ sau. Nếu nhánh `case when` không so sánh được thời gian thì lượt này
      // vẫn bị coi là vượt hạn mức — và người dùng bị chặn vĩnh viễn.
      const later = new Date(start.getTime() + 5_000);
      const fresh = await consumeShared(db, identity, 2, 1_000, later);
      expect(fresh.allowed).toBe(true);
      expect(fresh.remaining).toBe(1);
    });

    it('dọn được cửa sổ đã đóng', async () => {
      const identity = `sweep-${randomUUID()}`;
      await consumeShared(db, identity, 5, 1_000, new Date(Date.now() - 60_000));
      const removed = await sweepRateLimits(db, new Date());
      expect(removed).toBeGreaterThanOrEqual(1);
    });
  });

  describe('expireImpersonations', () => {
    it('đóng phiên đã hết giờ và chừa lại phiên còn hiệu lực', async () => {
      const userId = `itest-${randomUUID()}`;
      await db.insert(user).values({ id: userId, name: 'Integration', email: `${userId}@test.invalid` });
      madeUsers.push(userId);

      const [app] = await db
        .insert(infraApps)
        .values({ slug: `itest-${randomUUID().slice(0, 8)}`, name: 'Integration', ownerUserId: userId })
        .returning({ id: infraApps.id });
      if (app === undefined) throw new Error('app insert returned nothing');
      madeApps.push(app.id);

      const expiredId = randomUUID();
      const liveId = randomUUID();
      const base = {
        actorAdminId: userId,
        targetUserId: userId,
        appId: app.id,
        reason: 'integration test',
      };

      await db.insert(infraImpersonationSessions).values([
        { ...base, id: expiredId, expiresAt: new Date(Date.now() - 60_000) },
        { ...base, id: liveId, expiresAt: new Date(Date.now() + 600_000) },
      ]);

      const closed = await expireImpersonations(db);
      expect(closed).toBeGreaterThanOrEqual(1);

      const [expired] = await db
        .select()
        .from(infraImpersonationSessions)
        .where(eq(infraImpersonationSessions.id, expiredId));
      const [live] = await db
        .select()
        .from(infraImpersonationSessions)
        .where(eq(infraImpersonationSessions.id, liveId));

      expect(expired?.endedAt).not.toBeNull();
      expect(expired?.endedReason).toBe('expired');
      // Quan trọng ngang phần trên: nó KHÔNG được đóng phiên đang còn hạn.
      expect(live?.endedAt).toBeNull();
    });
  });
});
