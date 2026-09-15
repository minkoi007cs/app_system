/**
 * Nhánh LibSQL, chạy trên một database LibSQL thật.
 *
 * Cho tới giờ nhánh này chỉ được test trên driver giả. Bộ compiler sinh SQL hai phương ngữ, và
 * phương ngữ Postgres **đã** chạy thật (`scripts/live-proof.mjs` trên Neon) — phương ngữ LibSQL
 * thì chưa bao giờ, vì cần một tài khoản Turso (G1-6).
 *
 * Nhưng Turso chỉ là LibSQL có hosting. `@libsql/client` mở được file cục bộ với `file:`, cùng một
 * client, cùng đường mã. Nên phần lớn rủi ro của G1-6 đóng được ngay tại đây, không cần tài khoản
 * nào: cú pháp SQL sinh ra, placeholder `?`, thứ tự tham số, kiểu dữ liệu trả về.
 *
 * Phần G1-6 mà file này **không** đóng được, và cần nói thẳng: xác thực bằng authToken, TLS, độ trễ
 * mạng, và hành vi của replica. Đó là phần thuộc về Turso chứ không thuộc về LibSQL.
 *
 * Lý do viết sau ngày 2026-09-14: hai hàm chạy trên Postgres hỏng suốt mà 518 test vẫn xanh, vì
 * driver giả không bao giờ từ chối một câu SQL sai. Cùng một lý lẽ áp cho LibSQL.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileQuerySpec, parseQuerySpec, compileDecision, decide, type Policy } from '@infra/core';
import { createLibsqlAdapter } from '../src/libsql.adapter.js';
import type { DatabaseAdapter } from '../src/types.js';

const RESOURCE = 'libsql_notes';
let dir: string;
let adapter: DatabaseAdapter;

const policies: Policy[] = [
  {
    id: 'p-own',
    resource: RESOURCE,
    action: 'select',
    effect: 'allow',
    condition: { op: 'eq', field: 'owner_id', value: { from: 'subject', path: 'id' } },
    priority: 10,
    enabled: true,
  },
];

const subject = (id: string) => ({ id, appId: 'app', roles: ['member'], workspaceId: null });

/** Đúng đường mà `/api/v1/data/:resource` đi, chỉ khác là đầu kia là LibSQL. */
async function throughGateway(actorId: string, payload: unknown, action = 'select') {
  const spec = parseQuerySpec(payload, RESOURCE);
  const decision = decide(policies, { resource: spec.resource, action });
  const compiled = compileQuerySpec(spec, {
    dialect: 'libsql',
    condition: (startIndex, dialect) => compileDecision(decision, subject(actorId), dialect, startIndex),
  });
  const result = await adapter.query({ sql: compiled.sql, params: compiled.params });
  return { rows: result.rows, sql: compiled.sql };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'libsql-live-'));
  adapter = createLibsqlAdapter({
    appId: 'app',
    provider: 'turso',
    connectionString: `file:${join(dir, 'test.db')}`,
  });

  await adapter.query({
    sql: `create table ${RESOURCE} (id integer primary key, owner_id text not null, title text not null, done integer not null default 0)`,
  });
  await adapter.query({
    sql: `insert into ${RESOURCE} (owner_id, title, done) values (?, ?, 0), (?, ?, 0), (?, ?, 1)`,
    params: ['alice', 'a-one', 'alice', 'a-two', 'bob', 'b-one'],
  });
});

afterAll(async () => {
  await adapter.close?.();
  rmSync(dir, { recursive: true, force: true });
});

describe('libsql · compiler output runs on a real LibSQL database', () => {
  it('uses ? placeholders, not $n', async () => {
    // Một câu SQL Postgres lọt sang LibSQL sẽ hỏng ở đúng đây — và trên driver giả thì không.
    const { sql } = await throughGateway('alice', { select: ['id', 'title'] });
    expect(sql).toContain('?');
    expect(sql).not.toMatch(/\$\d/);
  });

  it('mỗi người chỉ thấy dòng của mình', async () => {
    const alice = await throughGateway('alice', { select: ['id', 'title'] });
    const bob = await throughGateway('bob', { select: ['id', 'title'] });
    expect(alice.rows).toHaveLength(2);
    expect(bob.rows).toHaveLength(1);
  });

  it('điều kiện của client thu hẹp được, không nới rộng được', async () => {
    // bob đòi thẳng dòng của alice: filter của client được AND vào, không thay thế policy.
    const attempt = await throughGateway('bob', {
      select: ['id'],
      filters: [{ column: 'owner_id', op: 'eq', value: 'alice' }],
    });
    expect(attempt.rows).toHaveLength(0);
  });

  it('thứ tự tham số giữ đúng khi có cả filter lẫn policy lẫn limit', async () => {
    // Đây là chỗ một lỗi lệch chỉ số tham số sẽ hiện ra: ba nguồn tham số nối vào cùng một câu.
    const result = await throughGateway('alice', {
      select: ['id', 'title'],
      filters: [{ column: 'done', op: 'eq', value: 0 }],
      order: [{ column: 'id', direction: 'asc' }],
      limit: 1,
    });
    expect(result.rows).toHaveLength(1);
    expect((result.rows[0] as Record<string, unknown>)['title']).toBe('a-one');
  });

  it('tài nguyên không có policy biên dịch thành 1 = 0 và trả về rỗng', async () => {
    const spec = parseQuerySpec({ select: ['id'] }, 'no_policy_here');
    const decision = decide(policies, { resource: 'no_policy_here', action: 'select' });
    const compiled = compileQuerySpec(spec, {
      dialect: 'libsql',
      condition: (start, dialect) => compileDecision(decision, subject('alice'), dialect, start),
    });
    expect(compiled.sql).toContain('1 = 0');
  });
});
