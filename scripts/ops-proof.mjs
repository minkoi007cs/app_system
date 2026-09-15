/**
 * Bằng chứng cho impersonation và webhook delivery trên Postgres thật.
 *
 * Hai đường này chưa từng chạy ngoài mock, và cả hai đều **được điều khiển bởi thời gian**:
 * impersonation hết hạn theo `expires_at`, webhook lùi lịch thử lại theo `next_attempt_at`. Đó đúng
 * là loại cột đã hỏng âm thầm hai lần trong dự án này — `expireImpersonations` ném lỗi mọi lần chạy
 * suốt nhiều tháng, và không ai biết vì nó chỉ được gọi từ một endpoint trả HTTP 200 bất chấp.
 *
 * Điều đáng kiểm nhất ở đây không phải "đường đi thuận lợi chạy được", mà là các hàng rào:
 *
 *   impersonation  — không tự mạo danh chính mình; không mạo danh admin khác (đó là leo thang
 *                    quyền sang quyền của admin thứ hai bằng credential của riêng mình); lý do
 *                    quá ngắn bị từ chối; phiên hết giờ ngừng đọc được.
 *   webhook        — URL nội bộ/metadata bị từ chối (SSRF); secret chỉ hiện một lần; chữ ký
 *                    kiểm được bằng secret đã cấp; thất bại lùi lịch tăng dần; breaker tắt
 *                    endpoint chết thay vì thử lại mãi.
 *
 * Chạy trên một Postgres **vứt đi**. Không in ra: secret, URL đầy đủ, nội dung payload.
 *
 *   node scripts/ops-proof.mjs
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function findRepoRoot() {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    current = dirname(current);
  }
  return process.cwd();
}
const ROOT = findRepoRoot();

const dsn = process.env.INFRA_MASTER_DATABASE_URL ?? '';
if (!/127\.0\.0\.1|localhost/.test(dsn)) {
  console.error('từ chối: chỉ chạy trên database cục bộ');
  process.exit(1);
}

const lines = [];
let failures = 0;
const say = (line) => {
  console.info(line);
  lines.push(line);
};
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  say(`${ok ? 'OK  ' : 'FAIL'}  ${label}: ${JSON.stringify(actual)} (kỳ vọng ${JSON.stringify(expected)})`);
};
/** Gọi một hàm và cho biết nó có ném lỗi hay không, không làm rơi script. */
const throws = async (fn) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

const db = await import(resolve(ROOT, 'packages/db/dist/index.js'));
const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));

const pnpmDir = resolve(ROOT, 'node_modules/.pnpm');
const postgresDir = readdirSync(pnpmDir).find((name) => /^postgres@\d/.test(name));
const { default: postgres } = await import(
  resolve(pnpmDir, postgresDir, 'node_modules/postgres/src/index.js')
);
const sql = postgres(dsn, { ssl: false, max: 2, prepare: false });
const conn = db.masterDb();

// ── gieo ─────────────────────────────────────────────────────────────────────

const mkUser = async (tag) => {
  const id = `ops-${tag}-${randomUUID()}`;
  await sql`insert into "user" (id, name, email, email_verified)
            values (${id}, ${tag}, ${`${id}@proof.invalid`}, true)`;
  return id;
};

const adminId = await mkUser('admin');
const otherAdminId = await mkUser('admin2');
const targetId = await mkUser('target');

await sql`insert into infra_platform_admins (user_id, role, status)
          values (${adminId}, 'super_admin', 'active'),
                 (${otherAdminId}, 'super_admin', 'active')`;

const app = await db.createApp(conn, {
  slug: `ops-${randomUUID().slice(0, 8)}`,
  name: 'Ops Proof',
  ownerUserId: adminId,
  allowedOrigins: [],
});

say(`ops-proof · ${new Date().toISOString()}`);
say('');

try {
  // ══ IMPERSONATION ════════════════════════════════════════════════════════
  say('── impersonation ──');

  check(
    'lý do quá ngắn bị từ chối',
    await throws(() => db.startImpersonation(conn, {
      actorAdminId: adminId, targetUserId: targetId, reason: 'test', appId: app.id,
    })),
    true,
  );

  check(
    'không tự mạo danh chính mình',
    await throws(() => db.startImpersonation(conn, {
      actorAdminId: adminId, targetUserId: adminId,
      reason: 'điều tra ticket SUP-1234 theo yêu cầu khách hàng', appId: app.id,
    })),
    true,
  );

  // Hàng rào chống leo thang quyền: mạo danh một admin khác là bước sang quyền của admin thứ hai
  // bằng đúng credential của mình.
  check(
    'KHÔNG mạo danh được một platform admin khác',
    await throws(() => db.startImpersonation(conn, {
      actorAdminId: adminId, targetUserId: otherAdminId,
      reason: 'điều tra ticket SUP-1234 theo yêu cầu khách hàng', appId: app.id,
    })),
    true,
  );

  const started = await db.startImpersonation(conn, {
    actorAdminId: adminId,
    targetUserId: targetId,
    reason: 'điều tra ticket SUP-1234 theo yêu cầu khách hàng',
    appId: app.id,
    ticketRef: 'SUP-1234',
    minutes: 15,
  });
  check('phiên hợp lệ được tạo', typeof started.id === 'string', true);
  check('ghi lại lý do', started.reason.length >= 10, true);
  check('có hạn giờ', started.expiresAt instanceof Date, true);

  const active = await db.activeImpersonation(conn, adminId);
  check('phiên đang mở đọc được', active?.id, started.id);

  // Hết giờ. Đây là đường mà `expireImpersonations` chạy — hàng tháng nó ném lỗi ở đây.
  await sql`update infra_impersonation_sessions set expires_at = now() - interval '1 minute'
            where id = ${started.id}`;
  check('phiên đã hết giờ KHÔNG còn đọc như đang mở', (await db.activeImpersonation(conn, adminId)) ?? null, null);

  const closed = await db.expireImpersonations(conn);
  check('job dọn đóng được phiên hết giờ', closed >= 1, true);

  const [row] = await sql`select ended_at, ended_reason from infra_impersonation_sessions where id = ${started.id}`;
  check('ghi lý do kết thúc là expired', row.ended_reason, 'expired');
  check('có mốc thời gian kết thúc', row.ended_at !== null, true);

  const secondPass = await db.expireImpersonations(conn);
  check('chạy lại job không đóng thêm gì (idempotent)', secondPass, 0);

  // ══ WEBHOOK ══════════════════════════════════════════════════════════════
  say('');
  say('── webhook ──');

  // SSRF: URL nội bộ và endpoint metadata của cloud phải bị từ chối TRƯỚC khi có dòng nào được ghi.
  for (const bad of [
    'http://localhost/hook',
    'https://127.0.0.1/hook',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/hook',
    'http://example.com/hook',
  ]) {
    check(
      `từ chối URL không an toàn (${bad.slice(0, 28)}…)`,
      await throws(() => db.createWebhookEndpoint(conn, { appId: app.id, url: bad })),
      true,
    );
  }

  const created = await db.createWebhookEndpoint(conn, {
    appId: app.id,
    url: 'https://hooks.proof.invalid/infra',
    eventTypes: ['user.created'],
  });
  check('secret cấp một lần có tiền tố whsec_', created.secret.startsWith('whsec_'), true);

  const [secretRow] = await sql`select encrypted_secret from infra_webhook_endpoints where id = ${created.row.id}`;
  check('secret KHÔNG lưu dạng thô', secretRow.encrypted_secret.includes(created.secret), false);
  // So sánh dưới dạng boolean, không truyền giá trị vào `check` — `check` in cả actual lẫn expected
  // vào log, nên so trực tiếp hai secret sẽ ghi secret ra file. Đúng thứ header file này cấm.
  check('giải mã lại ra đúng secret đã cấp', db.revealWebhookSecret(created.row) === created.secret, true);

  // Chỉ những loại sự kiện đã đăng ký mới được xếp hàng.
  const unsubscribed = await db.emitWebhookEvent(conn, app.id, 'user.deleted', { userId: targetId });
  check('sự kiện KHÔNG đăng ký thì không xếp hàng', unsubscribed.queued, 0);

  const emitted = await db.emitWebhookEvent(conn, app.id, 'user.created', { userId: targetId });
  check('sự kiện đã đăng ký thì xếp hàng', emitted.queued, 1);

  // Chữ ký phải kiểm được bằng đúng secret mà tenant nhận — nếu không thì secret vô dụng.
  const body = JSON.stringify(emitted.event);
  const timestamp = Math.floor(Date.now() / 1000);
  const header = core.signWebhook(created.secret, body, timestamp);
  check('tenant kiểm được chữ ký bằng secret của mình', core.verifyWebhook(created.secret, body, header), true);
  check('secret khác thì chữ ký không hợp lệ', core.verifyWebhook('whsec_khac', body, header), false);
  check('body bị sửa thì chữ ký không hợp lệ', core.verifyWebhook(created.secret, body + ' ', header), false);

  const due = await db.claimDueDeliveries(conn, 25);
  check('delivery tới hạn được nhận', due.length, 1);

  // Thất bại có thể thử lại → phải lùi lịch, chứ không phải quay lại hàng đợi ngay.
  await db.markAttemptFailed(conn, due[0].delivery, 503, 'upstream unavailable', true);
  const [failed] = await sql`select attempts, next_attempt_at, status, last_status_code
                             from infra_webhook_deliveries where id = ${due[0].delivery.id}`;
  check('số lần thử tăng lên', failed.attempts, 1);
  check('vẫn đang chờ', failed.status, 'pending');
  check('ghi mã lỗi HTTP', failed.last_status_code, 503);
  check('lùi lịch về tương lai, không thử lại ngay', new Date(failed.next_attempt_at) > new Date(), true);

  const notYetDue = await db.claimDueDeliveries(conn, 25);
  check('chưa tới hạn thì KHÔNG nhận lại', notYetDue.length, 0);

  // Breaker: một endpoint chết phải bị tắt, không thử lại vĩnh viễn.
  await sql`update infra_webhook_endpoints set consecutive_failures = ${db.BREAKER_THRESHOLD - 1}
            where id = ${created.row.id}`;
  await sql`update infra_webhook_deliveries set next_attempt_at = now() - interval '1 minute'
            where id = ${due[0].delivery.id}`;
  const retry = await db.claimDueDeliveries(conn, 25);
  check('tới hạn thì nhận lại được', retry.length, 1);

  await db.markAttemptFailed(conn, retry[0].delivery, 500, 'still broken', true);
  const [endpointAfter] = await sql`select status, disabled_at, consecutive_failures
                                   from infra_webhook_endpoints where id = ${created.row.id}`;
  check(`đủ ${db.BREAKER_THRESHOLD} lần hỏng liên tiếp thì breaker tắt endpoint`, endpointAfter.status, 'disabled');
  check('ghi mốc thời gian tắt', endpointAfter.disabled_at !== null, true);

  const afterBreaker = await db.claimDueDeliveries(conn, 25);
  check('endpoint đã tắt thì không lấy việc nữa', afterBreaker.length, 0);

  // Thành công phải reset bộ đếm — nếu không, một endpoint hay hỏng rồi tự lành vẫn bị tắt oan.
  await db.setWebhookEndpointStatus(conn, created.row.id, 'active');
  await sql`update infra_webhook_deliveries set next_attempt_at = now() - interval '1 minute', status = 'pending'
            where id = ${due[0].delivery.id}`;
  const again = await db.claimDueDeliveries(conn, 25);
  await db.markDelivered(conn, again[0].delivery.id, created.row.id, 200);

  const [healed] = await sql`select consecutive_failures, last_success_at
                            from infra_webhook_endpoints where id = ${created.row.id}`;
  check('giao thành công reset bộ đếm hỏng liên tiếp', healed.consecutive_failures, 0);
  check('ghi mốc thành công gần nhất', healed.last_success_at !== null, true);

  const [delivered] = await sql`select status, delivered_at, last_error
                               from infra_webhook_deliveries where id = ${due[0].delivery.id}`;
  check('delivery được đánh dấu đã giao', delivered.status, 'delivered');
  check('xoá lỗi cũ khi đã thành công', delivered.last_error, null);

  // Xoay secret phải làm chữ ký cũ vô hiệu.
  const rotated = await db.rotateWebhookSecret(conn, created.row.id);
  check('secret mới khác secret cũ', rotated !== created.secret, true);
  check('chữ ký ký bằng secret CŨ không còn hợp lệ', core.verifyWebhook(rotated, body, header), false);
} catch (error) {
  failures += 1;
  const message = error instanceof Error ? error.message : 'lỗi không rõ';
  say(`FAIL  ngoại lệ: ${message.slice(0, 200)}`);
} finally {
  await sql`delete from infra_apps where id = ${app.id}`.catch(() => {});
  await sql`delete from infra_platform_admins where user_id in (${adminId}, ${otherAdminId})`.catch(() => {});
  await sql`delete from "user" where id in (${adminId}, ${otherAdminId}, ${targetId})`.catch(() => {});
  await sql.end({ timeout: 5 });
}

say('');
say(failures === 0 ? '🟢 TẤT CẢ ĐÚNG — impersonation và webhook giữ được trên dữ liệu thật'
                   : `🔴 ${failures} khẳng định SAI`);

mkdirSync(resolve(ROOT, 'logs'), { recursive: true });
const name = `logs/ops-proof-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
writeFileSync(resolve(ROOT, name), lines.join('\n') + '\n', 'utf8');
console.info(`\nđã ghi ${name}`);
process.exit(failures === 0 ? 0 : 1);
