import { describe, expect, it } from 'vitest';
import { sqlIntent } from '../src/lib/sql-intent';
import { DEFAULT_LIMIT, localRefusal, sweep } from '../src/lib/rate-limit';
import { describeFailures, statusForJobs } from '../src/lib/job-report';
import { booleanField, stringField, toSnakeCase } from '../src/lib/body-fields';

describe('sqlIntent', () => {
  it('treats plain selects as reads', () => {
    expect(sqlIntent('select * from notes')).toBe('read');
    expect(sqlIntent('  SELECT 1  ')).toBe('read');
    expect(sqlIntent('with recent as (select 1) select * from recent')).toBe('read');
  });

  it('treats mutations as writes', () => {
    for (const sql of [
      'insert into notes (id) values ($1)',
      'UPDATE notes set title = $1',
      'delete from notes where id = $1',
      'drop table notes',
      'alter table notes add column x int',
      'truncate notes',
    ]) {
      expect(sqlIntent(sql)).toBe('write');
    }
  });

  it('is not fooled by a leading comment', () => {
    expect(sqlIntent('-- harmless\n delete from notes')).toBe('write');
    expect(sqlIntent('/* block */ update notes set a = 1')).toBe('write');
  });

  it('treats select … for update as a write', () => {
    expect(sqlIntent('select * from notes for update')).toBe('write');
  });
});

describe('rate limit — the local layer', () => {
  // The shared counter in the Master DB is the authority; this layer exists only to turn away
  // abusive traffic without a round trip. So the property under test is negative.

  it('never returns an allowed verdict — it can only refuse or defer', () => {
    const key = `key-${Math.random()}`;
    const now = 1_000_000;

    for (let i = 0; i < DEFAULT_LIMIT + 50; i += 1) {
      const verdict = localRefusal(key, DEFAULT_LIMIT, now);
      // Either "ask the shared store" (null) or a refusal. Never a local yes.
      if (verdict !== null) expect(verdict.allowed).toBe(false);
    }
  });

  it('defers while under the limit, then refuses', () => {
    const key = `key-${Math.random()}`;
    const now = 1_000_000;

    for (let i = 0; i < DEFAULT_LIMIT; i += 1) {
      expect(localRefusal(key, DEFAULT_LIMIT, now)).toBeNull();
    }
    expect(localRefusal(key, DEFAULT_LIMIT, now)?.allowed).toBe(false);
  });

  it('starts a new window once the old one has passed', () => {
    const key = `key-${Math.random()}`;
    expect(localRefusal(key, 1, 0)).toBeNull();
    expect(localRefusal(key, 1, 10)?.allowed).toBe(false);
    expect(localRefusal(key, 1, 60_001)).toBeNull();
  });

  it('keeps separate budgets per identity', () => {
    expect(localRefusal(`a-${Math.random()}`, 1, 0)).toBeNull();
    expect(localRefusal(`b-${Math.random()}`, 1, 0)).toBeNull();
  });

  it('sweeps closed windows', () => {
    const key = `key-${Math.random()}`;
    localRefusal(key, 1, 0);
    sweep(120_000);
    expect(localRefusal(key, 1, 120_001)).toBeNull();
  });

  it('reports how long the refusal lasts', () => {
    const key = `key-${Math.random()}`;
    localRefusal(key, 1, 0);
    const verdict = localRefusal(key, 1, 1_000);
    expect(verdict?.resetInMs).toBe(59_000);
    expect(verdict?.remaining).toBe(0);
  });
});

describe('statusForJobs', () => {
  it('gives a 200 only when every job succeeded', () => {
    expect(statusForJobs([{ job: 'a', ok: true, detail: 0 }])).toBe(200);
    expect(statusForJobs([])).toBe(200);
  });

  it('gives a non-2xx as soon as one job failed', () => {
    // Bất biến thật sự của endpoint này. Cron gọi bằng `curl -fsS` để một lần hỏng thành mã thoát
    // khác 0; trả 200 kèm `ok:false` trong body khiến kiểm tra đó vô nghĩa — và đó đúng là cách
    // `expireImpersonations` hỏng suốt mà không ai biết.
    expect(
      statusForJobs([
        { job: 'a', ok: true, detail: 0 },
        { job: 'b', ok: false, detail: 'Error' },
        { job: 'c', ok: true, detail: 3 },
      ]),
    ).toBeGreaterThanOrEqual(500);
  });

  it('names which jobs failed, and says nothing when none did', () => {
    expect(describeFailures([{ job: 'a', ok: true, detail: 0 }])).toBe('');
    const line = describeFailures([
      { job: 'a', ok: true, detail: 0 },
      { job: 'impersonations', ok: false, detail: 'Error' },
    ]);
    expect(line).toContain('impersonations');
    expect(line).toContain('1/2');
  });
});

describe('body field naming tolerance', () => {
  it('đọc được cả camelCase và snake_case', () => {
    expect(stringField({ refreshToken: 'a' }, 'refreshToken')).toBe('a');
    expect(stringField({ refresh_token: 'b' }, 'refreshToken')).toBe('b');
    expect(stringField({ grant_type: 'password' }, 'grantType')).toBe('password');
  });

  it('camelCase thắng khi cả hai cùng có mặt', () => {
    // Xác định, không phụ thuộc thứ tự khoá trong JSON.
    expect(stringField({ refreshToken: 'camel', refresh_token: 'snake' }, 'refreshToken')).toBe('camel');
    expect(stringField({ refresh_token: 'snake', refreshToken: 'camel' }, 'refreshToken')).toBe('camel');
  });

  it('trả null cho thiếu, rỗng, hoặc không phải chuỗi — không bao giờ chuỗi rỗng', () => {
    // Chuỗi rỗng phải được coi như thiếu: một `refreshToken: ""` lọt qua sẽ đi tra hash của chuỗi rỗng.
    expect(stringField({}, 'refreshToken')).toBeNull();
    expect(stringField({ refreshToken: '' }, 'refreshToken')).toBeNull();
    expect(stringField({ refresh_token: '' }, 'refreshToken')).toBeNull();
    expect(stringField({ refreshToken: 123 }, 'refreshToken')).toBeNull();
    expect(stringField({ refreshToken: null }, 'refreshToken')).toBeNull();
    expect(stringField(null, 'refreshToken')).toBeNull();
    expect(stringField('not-an-object', 'refreshToken')).toBeNull();
  });

  it('cờ boolean chỉ đúng khi là true thật, không phải giá trị truthy', () => {
    // `allSessions: 'no'` thu hồi MỌI phiên của người dùng nếu nhận truthy. Phải là true.
    expect(booleanField({ allSessions: true }, 'allSessions')).toBe(true);
    expect(booleanField({ all_sessions: true }, 'allSessions')).toBe(true);
    expect(booleanField({ allSessions: 'true' }, 'allSessions')).toBe(false);
    expect(booleanField({ allSessions: 1 }, 'allSessions')).toBe(false);
    expect(booleanField({}, 'allSessions')).toBe(false);
  });

  it('chuyển tên đúng cho các trường của API này', () => {
    expect(toSnakeCase('refreshToken')).toBe('refresh_token');
    expect(toSnakeCase('grantType')).toBe('grant_type');
    expect(toSnakeCase('allSessions')).toBe('all_sessions');
    expect(toSnakeCase('email')).toBe('email');
  });
});
