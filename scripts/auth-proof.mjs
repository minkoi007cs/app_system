/**
 * Bằng chứng cho đường xác thực: xoay vòng refresh token và **phát hiện tái sử dụng**, trên
 * database thật, qua đúng HTTP endpoint mà app con gọi.
 *
 * Vì sao cần: đây là cơ chế bảo mật quan trọng nhất của hệ thống và là cơ chế có hành vi khó nhất
 * — một refresh token dùng lại phải thu hồi **cả family**, không chỉ token đó. Nó cũng là lý do
 * SDK **buộc phải** gộp refresh single-flight (ADR-018): năm request song song với token cũ sinh
 * ra năm lần refresh, bốn lần trình token đã cháy, reuse detection đá người dùng ra — trong khi
 * mọi tầng đều hành xử đúng.
 *
 * Cho tới giờ toàn bộ chuyện đó chỉ được chứng minh bằng unit test trên driver giả. Ngày
 * 2026-09-14, hai hàm khác cũng "được chứng minh" như vậy hoá ra chưa từng chạy được lần nào, vì
 * một `Date` trong template `sql` thô không parse được ở Postgres. `infra_refresh_tokens` có ba
 * cột timestamp. Nên phải chạy thật.
 *
 * Chạy trên một Postgres **vứt đi** + một `next start` cục bộ. Không in ra: token, khoá, mật khẩu.
 *
 *   node scripts/auth-proof.mjs http://127.0.0.1:3100
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3100';

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

// ── thư viện của chính dự án ─────────────────────────────────────────────────
const db = await import(resolve(ROOT, 'packages/db/dist/index.js'));
const authPkg = await import(resolve(ROOT, 'packages/auth/dist/index.js'));

const pnpmDir = resolve(ROOT, 'node_modules/.pnpm');
const postgresDir = readdirSync(pnpmDir).find((name) => /^postgres@\d/.test(name));
const { default: postgres } = await import(
  resolve(pnpmDir, postgresDir, 'node_modules/postgres/src/index.js')
);
const sql = postgres(dsn, { ssl: false, max: 2, prepare: false });

// ── gieo: một app, một khoá pk_, một người dùng có mật khẩu ──────────────────

const conn = db.masterDb();
const email = `proof-${randomUUID().slice(0, 8)}@proof.invalid`;
const password = `Proof-${randomUUID()}-Aa1!`;

const ownerId = `proof-owner-${randomUUID()}`;
await sql`insert into "user" (id, name, email, email_verified) values (${ownerId}, 'Proof Owner', ${`owner-${ownerId}@proof.invalid`}, true)`;

const app = await db.createApp(conn, {
  slug: `proof-${randomUUID().slice(0, 8)}`,
  name: 'Auth Proof',
  ownerUserId: ownerId,
  allowedOrigins: [],
});

const issued = await db.issueApiKey(conn, {
  appId: app.id,
  name: 'proof-pk',
  createdBy: ownerId,
  kind: 'publishable',
  scopes: ['auth:read', 'db:read'],
});
const pk = issued.rawKey;

// Người dùng: đăng ký qua đúng API mà runtime dùng.
//
// Bản đầu của script này tự viết dòng `account` bằng `context.password.hash` — và `signInEmail`
// trả 401. Tự dựng credential row nghĩa là tự đoán những gì Better Auth mong đợi, và đoán sai thì
// bằng chứng nói về cái mình dựng chứ không nói về hệ thống. Nên gọi thẳng signUpEmail.
const signUp = await authPkg.auth().api.signUpEmail({
  body: { email, password, name: 'Proof User' },
});
const userId = signUp.user.id;
await sql`update "user" set email_verified = true where id = ${userId}`;
await db.addMember(conn, app.id, userId, 'member');

say(`auth-proof · ${new Date().toISOString()}`);
say(`app ${app.slug} · khoá pk_ đã cấp · người dùng đã tạo (email che: ${email.slice(0, 6)}***)`);
say('');

// ── helper HTTP ──────────────────────────────────────────────────────────────

async function post(path, body, extraHeaders = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pk}`, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function familyCount() {
  return sql`select count(*)::int as n from infra_refresh_tokens where user_id = ${userId}`.then((r) => r[0].n);
}
function liveCount() {
  return sql`select count(*)::int as n from infra_refresh_tokens
             where user_id = ${userId} and revoked_at is null and used_at is null`.then((r) => r[0].n);
}

try {
  // ── 1. đổi mật khẩu lấy cặp token ──────────────────────────────────────────
  const first = await post('/api/v1/auth/token', { grant_type: 'password', email, password });
  check('đăng nhập đúng mật khẩu trả 200', first.status, 200);

  const pair1 = first.json?.data ?? {};
  check('có access token', typeof pair1.accessToken === 'string' && pair1.accessToken.length > 20, true);
  check('có refresh token', typeof pair1.refreshToken === 'string' && pair1.refreshToken.length > 20, true);
  check('đã ghi 1 dòng refresh token', await familyCount(), 1);

  // ── 2. mật khẩu sai phải bị từ chối ────────────────────────────────────────
  const wrong = await post('/api/v1/auth/token', { grant_type: 'password', email, password: 'wrong-password-here' });
  check('mật khẩu sai không trả 200', wrong.status !== 200, true);
  check('mật khẩu sai không sinh thêm refresh token', await familyCount(), 1);

  // ── 3. xoay vòng: refresh hợp lệ cấp token mới và đốt token cũ ─────────────
  const rotated = await post('/api/v1/auth/refresh', { refreshToken: pair1.refreshToken });
  check('refresh hợp lệ trả 200', rotated.status, 200);

  const pair2 = rotated.json?.data ?? {};
  check('refresh token mới KHÁC token cũ', pair2.refreshToken !== pair1.refreshToken, true);
  check('family có 2 dòng sau một lần xoay', await familyCount(), 2);
  check('chỉ còn 1 token còn dùng được', await liveCount(), 1);

  // ── 4. TÁI SỬ DỤNG: trình lại token đã bị đốt ──────────────────────────────
  // Đây là khẳng định trung tâm. Trình lại token cũ không chỉ phải bị từ chối — nó phải thu hồi
  // **cả family**, vì một token đã dùng xuất hiện lần hai nghĩa là có bản sao credential ở đâu đó.
  const replay = await post('/api/v1/auth/refresh', { refreshToken: pair1.refreshToken });
  check('trình lại token đã đốt không trả 200', replay.status !== 200, true);
  check('sau tái sử dụng: KHÔNG còn token nào dùng được (cả family bị thu hồi)', await liveCount(), 0);

  // ── 5. token mới cũng chết theo family ─────────────────────────────────────
  const afterReuse = await post('/api/v1/auth/refresh', { refreshToken: pair2.refreshToken });
  check('token mới (hợp lệ trước đó) cũng bị từ chối sau khi family bị thu hồi', afterReuse.status !== 200, true);

  // ── 6. audit log phải ghi lại sự kiện ──────────────────────────────────────
  const reuseLogged = await sql`select count(*)::int as n from infra_audit_logs
                                where action = 'auth.token.reuse_detected'`;
  check('audit log có auth.token.reuse_detected', reuseLogged[0].n >= 1, true);

  // ── 7. đăng nhập lại vẫn được — thu hồi family không khoá tài khoản ────────
  const again = await post('/api/v1/auth/token', { grant_type: 'password', email, password });
  check('đăng nhập lại bằng mật khẩu vẫn được sau khi family bị thu hồi', again.status, 200);
  check('có đúng 1 token dùng được trở lại', await liveCount(), 1);

  // ── 8. token rác bị từ chối, không làm sập gì ──────────────────────────────
  const garbage = await post('/api/v1/auth/refresh', { refreshToken: 'rt_not_a_real_token_at_all' });
  check('token rác không trả 200', garbage.status !== 200, true);
  check('token rác không chạm family hiện tại', await liveCount(), 1);

  // ── 9. hai quy ước tên trường phải tương đương ─────────────────────────────
  // `/token` theo OAuth (`grant_type`), `/refresh` và `/revoke` theo quy ước của API này
  // (`refreshToken`). Bắt người tích hợp nhớ endpoint nào theo quy ước nào là nợ, không phải thiết
  // kế — nên cả ba nhận cả hai dạng. Kiểm bằng cách gửi ĐÚNG dạng đối nghịch ở mỗi endpoint.
  const snakeLogin = await post('/api/v1/auth/token', { grantType: 'password', email, password });
  check('/token nhận camelCase grantType', snakeLogin.status, 200);

  const snakePair = snakeLogin.json?.data ?? {};
  const snakeRefresh = await post('/api/v1/auth/refresh', { refresh_token: snakePair.refreshToken });
  check('/refresh nhận snake_case refresh_token', snakeRefresh.status, 200);

  // Đếm TRƯỚC khi revoke. Ở đây đang có hai phiên sống (một từ bước 7, một vừa tạo), và đó chính
  // là điều làm khẳng định này đáng giá: revoke phải đóng ĐÚNG phiên được nêu tên, không phải mọi
  // phiên của người dùng. Khẳng định "còn 0" của bản trước sẽ đúng vì lý do sai — nó sẽ xanh cả khi
  // revoke đăng xuất người dùng khỏi mọi thiết bị.
  const beforeSnakeRevoke = await liveCount();
  const snakeRevoke = await post('/api/v1/auth/revoke', {
    refresh_token: (snakeRefresh.json?.data ?? {}).refreshToken,
  });
  check('/revoke nhận snake_case refresh_token', snakeRevoke.status >= 200 && snakeRevoke.status < 300, true);
  check('revoke đóng ĐÚNG MỘT phiên, không phải tất cả', await liveCount(), beforeSnakeRevoke - 1);

  // ── 10. revoke phải đóng phiên ─────────────────────────────────────────────
  const fresh = await post('/api/v1/auth/token', { grant_type: 'password', email, password });
  const live = fresh.json?.data ?? {};
  const beforeRevoke = await liveCount();
  const revoked = await post('/api/v1/auth/revoke', { refreshToken: live.refreshToken });
  check('revoke trả 2xx', revoked.status >= 200 && revoked.status < 300, true);
  check('revoke bằng camelCase cũng đóng đúng một phiên', await liveCount(), beforeRevoke - 1);

  // ── 11. allSessions đóng hết, và đó là hành vi có chủ đích khác với trên ────
  const remaining = await liveCount();
  check('còn phiên sống trước khi thu hồi tất cả', remaining > 0, true);
  const all = await post('/api/v1/auth/revoke', { all_sessions: true, accessToken: live.accessToken });
  check('/revoke nhận snake_case all_sessions', all.status >= 200 && all.status < 300, true);
  check('allSessions thu hồi hết', await liveCount(), 0);
} catch (error) {
  failures += 1;
  const message = error instanceof Error ? error.message : 'lỗi không rõ';
  say(`FAIL  ngoại lệ: ${message.slice(0, 200)}`);
} finally {
  // Dọn sạch: xoá app (cascade) và hai user.
  await sql`delete from infra_apps where id = ${app.id}`.catch(() => {});
  await sql`delete from "user" where id in (${userId}, ${ownerId})`.catch(() => {});
  await sql.end({ timeout: 5 });
}

say('');
say(failures === 0 ? '🟢 TẤT CẢ ĐÚNG — xoay vòng và phát hiện tái sử dụng giữ được trên dữ liệu thật'
                   : `🔴 ${failures} khẳng định SAI`);

mkdirSync(resolve(ROOT, 'logs'), { recursive: true });
const name = `logs/auth-proof-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
writeFileSync(resolve(ROOT, name), lines.join('\n') + '\n', 'utf8');
console.info(`\nđã ghi ${name}`);
process.exit(failures === 0 ? 0 : 1);
