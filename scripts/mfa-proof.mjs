/**
 * Bằng chứng cho MFA/TOTP trên Postgres thật.
 *
 * `infra_mfa_factors` mang **cả hai** loại thứ đã hỏng âm thầm trong dự án này: một envelope
 * ciphertext (seed TOTP, AAD buộc theo dòng) và nhiều cột timestamp. Hai lần trước, cùng loại cột
 * đó hỏng trên Postgres trong khi 518 test xanh, vì driver giả không bao giờ từ chối một tham số
 * sai kiểu.
 *
 * Và hậu quả nếu MFA hỏng là **khoá người dùng ra khỏi tài khoản của chính họ** — không phải lỗi
 * trả về đẹp đẽ, mà "mã đúng nhưng hệ thống nói sai".
 *
 * Khẳng định quan trọng nhất ở đây không phải "mã đúng thì qua". Đó là **chống phát lại**: một mã
 * TOTP đã dùng phải bị từ chối ngay cả khi vẫn còn trong cửa sổ trôi thời gian 30 giây — nếu không,
 * ai đọc được mã qua vai người dùng có 30 giây để dùng lại nó.
 *
 * Chạy trên một Postgres **vứt đi**. Không in ra: seed, backup code, mật khẩu.
 *
 *   node scripts/mfa-proof.mjs
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

const db = await import(resolve(ROOT, 'packages/db/dist/index.js'));
const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));
const { totpCode, TOTP_STEP_SECONDS } = core;

const pnpmDir = resolve(ROOT, 'node_modules/.pnpm');
const postgresDir = readdirSync(pnpmDir).find((name) => /^postgres@\d/.test(name));
const { default: postgres } = await import(
  resolve(pnpmDir, postgresDir, 'node_modules/postgres/src/index.js')
);
const sql = postgres(dsn, { ssl: false, max: 2, prepare: false });
const conn = db.masterDb();

const userId = `mfa-${randomUUID()}`;
await sql`insert into "user" (id, name, email, email_verified)
          values (${userId}, 'MFA Proof', ${`${userId}@proof.invalid`}, true)`;

say(`mfa-proof · ${new Date().toISOString()}`);
say('');

try {
  // ── 1. đăng ký: seed được niêm phong, factor CHƯA dùng được ────────────────
  const enrol = await db.startTotpEnrolment(conn, userId, 'proof@infra.test', 'Infra Proof');
  check('đăng ký trả về factorId', typeof enrol.factorId === 'string' && enrol.factorId.length > 10, true);
  check('trả về secret base32 để quét QR', /^[A-Z2-7]{16,}$/.test(enrol.secretBase32), true);
  check('trả về otpauth URI', enrol.otpauthUri.startsWith('otpauth://totp/'), true);

  const [stored] = await sql`select encrypted_secret, encryption_iv, encryption_auth_tag, verified_at
                             from infra_mfa_factors where id = ${enrol.factorId}`;
  check('seed KHÔNG lưu dạng thô', stored.encrypted_secret.includes(enrol.secretBase32), false);
  check('có IV và auth tag', stored.encryption_iv.length === 24 && stored.encryption_auth_tag.length === 32, true);
  check('factor chưa xác minh thì verified_at là null', stored.verified_at, null);
  check('factor chưa xác minh KHÔNG tính là có MFA', await db.hasVerifiedMfa(conn, userId), false);

  // ── 2. mã sai không kích hoạt được ─────────────────────────────────────────
  let rejected = false;
  try {
    await db.activateTotpFactor(conn, enrol.factorId, userId, '000000');
  } catch {
    rejected = true;
  }
  check('mã sai không kích hoạt được factor', rejected, true);
  check('sau mã sai vẫn chưa có MFA', await db.hasVerifiedMfa(conn, userId), false);

  // ── 3. mã đúng kích hoạt, và trả về backup code ────────────────────────────
  const now = new Date();
  const code = totpCode(enrol.secretBase32, now.getTime());
  const activated = await db.activateTotpFactor(conn, enrol.factorId, userId, code, now);

  check('mã đúng kích hoạt được factor', activated.factor.verifiedAt !== null, true);
  check('factor đầu tiên thành primary', activated.factor.isPrimary, true);
  check('cấp backup code', Array.isArray(activated.backupCodes) && activated.backupCodes.length >= 8, true);
  check('giờ đã có MFA đã xác minh', await db.hasVerifiedMfa(conn, userId), true);

  const [afterActivate] = await sql`select backup_code_hashes from infra_mfa_factors where id = ${enrol.factorId}`;
  const hashes = afterActivate.backup_code_hashes;
  check('chỉ lưu HASH của backup code', hashes.includes(activated.backupCodes[0]), false);
  check('số hash khớp số code đã cấp', hashes.length, activated.backupCodes.length);

  // ── 4. kích hoạt hai lần phải bị từ chối ───────────────────────────────────
  let twice = false;
  try {
    await db.activateTotpFactor(conn, enrol.factorId, userId, code, now);
  } catch {
    twice = true;
  }
  check('không kích hoạt được factor đã active lần nữa', twice, true);

  // ── 5. CHỐNG PHÁT LẠI — khẳng định trung tâm ───────────────────────────────
  // Mã vừa dùng để kích hoạt vẫn còn trong cửa sổ 30 giây. Nó PHẢI bị từ chối. Nếu không, ai nhìn
  // qua vai người dùng có 30 giây để dùng lại chính mã đó.
  let replayRejected = false;
  try {
    await db.verifyMfaCode(conn, userId, code, now);
  } catch {
    replayRejected = true;
  }
  check('mã TOTP đã dùng bị từ chối dù còn trong cửa sổ trôi', replayRejected, true);

  // ── 6. mã của bước kế tiếp thì qua ─────────────────────────────────────────
  const later = new Date(now.getTime() + TOTP_STEP_SECONDS * 1000);
  const nextCode = totpCode(enrol.secretBase32, later.getTime());
  check('mã của bước thời gian mới là mã khác', nextCode !== code, true);

  const verified = await db.verifyMfaCode(conn, userId, nextCode, later);
  check('mã của bước mới được chấp nhận', verified.method, 'totp');

  // ── 7. backup code: dùng được một lần, rồi cháy ────────────────────────────
  const backup = activated.backupCodes[0];
  const used = await db.verifyMfaCode(conn, userId, backup, later);
  check('backup code được chấp nhận', used.method, 'backup_code');
  check('còn lại ít hơn một code', used.backupCodesRemaining, activated.backupCodes.length - 1);

  let burnt = false;
  try {
    await db.verifyMfaCode(conn, userId, backup, later);
  } catch {
    burnt = true;
  }
  check('backup code đã dùng KHÔNG dùng lại được', burnt, true);

  const [afterBurn] = await sql`select backup_code_hashes from infra_mfa_factors where id = ${enrol.factorId}`;
  check('hash của code đã cháy bị xoá khỏi database', afterBurn.backup_code_hashes.length,
        activated.backupCodes.length - 1);

  // ── 8. sinh lại backup code phải thay thế hết, không phải cộng thêm ────────
  const fresh = await db.regenerateBackupCodes(conn, enrol.factorId, userId);
  const [afterRegen] = await sql`select backup_code_hashes from infra_mfa_factors where id = ${enrol.factorId}`;
  check('sinh lại thì THAY THẾ bộ cũ, không cộng thêm', afterRegen.backup_code_hashes.length, fresh.length);

  let oldBackupDead = false;
  try {
    await db.verifyMfaCode(conn, userId, activated.backupCodes[1], later);
  } catch {
    oldBackupDead = true;
  }
  check('backup code cũ chết sau khi sinh lại', oldBackupDead, true);

  // ── 9. mã của người khác không mở được factor này ──────────────────────────
  const otherUser = `mfa-other-${randomUUID()}`;
  await sql`insert into "user" (id, name, email, email_verified)
            values (${otherUser}, 'Other', ${`${otherUser}@proof.invalid`}, true)`;
  const otherEnrol = await db.startTotpEnrolment(conn, otherUser, 'other@infra.test', 'Infra Proof');
  const otherCode = totpCode(otherEnrol.secretBase32, later.getTime());

  let crossRejected = false;
  try {
    await db.verifyMfaCode(conn, userId, otherCode, later);
  } catch {
    crossRejected = true;
  }
  check('mã sinh từ seed của người khác bị từ chối', crossRejected, true);

  // ── 10. xoá factor thì mất trạng thái MFA ──────────────────────────────────
  await db.removeMfaFactor(conn, enrol.factorId, userId);
  check('sau khi xoá factor cuối: không còn MFA', await db.hasVerifiedMfa(conn, userId), false);

  await sql`delete from "user" where id = ${otherUser}`;
} catch (error) {
  failures += 1;
  const message = error instanceof Error ? error.message : 'lỗi không rõ';
  say(`FAIL  ngoại lệ: ${message.slice(0, 200)}`);
} finally {
  await sql`delete from "user" where id = ${userId}`.catch(() => {});
  await sql.end({ timeout: 5 });
}

say('');
say(failures === 0 ? '🟢 TẤT CẢ ĐÚNG — MFA/TOTP giữ được trên dữ liệu thật'
                   : `🔴 ${failures} khẳng định SAI`);

mkdirSync(resolve(ROOT, 'logs'), { recursive: true });
const name = `logs/mfa-proof-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
writeFileSync(resolve(ROOT, name), lines.join('\n') + '\n', 'utf8');
console.info(`\nđã ghi ${name}`);
process.exit(failures === 0 ? 0 : 1);
