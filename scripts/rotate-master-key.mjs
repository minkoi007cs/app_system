/**
 * Xoay `INFRA_MASTER_ENCRYPTION_KEY` — mã hoá lại **mọi** ciphertext trong Master DB.
 *
 * Tồn tại vì runbook §2 mô tả một quy trình mà công cụ không làm được. `rotate-encryption-key.py`
 * chỉ đổi khoá trong `.env.local`, và nó **từ chối chạy khi đã có dòng mã hoá** — đúng như thiết
 * kế của nó. Nhưng runbook lại bảo chạy nó *sau khi* đã có dữ liệu, để "xoay khoá". Làm theo sẽ
 * mất quyền giải mã mọi connection string của app con: không có đường khôi phục (rủi ro R2).
 *
 * Bốn bảng giữ ciphertext, không phải một. Runbook cũ chỉ dặn kiểm tra health của app — nghĩa là
 * chỉ kiểm một trong bốn. Ba bảng còn lại hỏng âm thầm:
 *
 *   infra_database_configs   connection string      AAD = `<app_id>:<config_id>`
 *   infra_signing_keys       private key PEM        AAD = `signing-key:<kid>`   → hỏng = mọi JWT chết
 *   infra_webhook_endpoints  whsec_ signing secret  AAD = `webhook:<id>`        → hỏng = app con từ chối mọi webhook
 *   infra_mfa_factors        TOTP seed              AAD = `mfa:<factor_id>`     → hỏng = người dùng bật MFA bị khoá ngoài
 *
 * AAD buộc ciphertext vào đúng dòng sở hữu nó, nên mã hoá lại phải giữ nguyên AAD. Khoá đổi, ngữ
 * cảnh thì không.
 *
 * Cách dùng — khoá cũ giữ nguyên ở biến của phiên bản cũ, khoá mới ở biến của phiên bản mới:
 *
 *   INFRA_MASTER_ENCRYPTION_KEY      = khoá cũ        (phiên bản 1)
 *   INFRA_MASTER_ENCRYPTION_KEY_V2   = khoá mới       (phiên bản 2)
 *   INFRA_MASTER_ENCRYPTION_KEY_VERSION = 2           (đặt SAU khi script chạy xong)
 *
 *   node scripts/rotate-master-key.mjs --to 2 --dry-run   đếm, không ghi
 *   node scripts/rotate-master-key.mjs --to 2             ghi thật, từng dòng một
 *
 * **Không bao giờ đảo hai khoá cho nhau.** Đặt khoá mới vào biến của khoá cũ là cách nhanh nhất để
 * mất toàn bộ dữ liệu ở đây: mọi dòng đang mang `encryption_key_version = 1` sẽ đi tìm khoá cũ,
 * thấy khoá mới, và không giải mã được gì.
 *
 * Không in ra: connection string, khoá, seed TOTP, secret webhook, private key. Chỉ tên bảng và
 * số đếm.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ── tham số ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const toIndex = argv.indexOf('--to');
const TARGET_VERSION = toIndex === -1 ? NaN : Number(argv[toIndex + 1]);

if (!Number.isInteger(TARGET_VERSION) || TARGET_VERSION < 2) {
  console.error('dùng: node scripts/rotate-master-key.mjs --to <phiên bản ≥ 2> [--dry-run]');
  console.error('phiên bản 1 là khoá gốc — xoay nghĩa là đi lên 2, 3, …');
  process.exit(1);
}

// ── môi trường ───────────────────────────────────────────────────────────────

function findRepoRoot() {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    current = dirname(current);
  }
  return process.cwd();
}

const ROOT = findRepoRoot();
const envPath = resolve(ROOT, process.env.INFRA_ENV_FILE ?? '.env.local');

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    if (process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
}

const lines = [];
const say = (line) => {
  console.info(line);
  lines.push(line);
};

function writeLog(ok) {
  mkdirSync(resolve(ROOT, 'logs'), { recursive: true });
  const name = `logs/rotate-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  writeFileSync(resolve(ROOT, name), lines.join('\n') + '\n', 'utf8');
  console.info(`\nđã ghi ${name}`);
  process.exit(ok ? 0 : 1);
}

// ── thư viện của chính dự án ─────────────────────────────────────────────────
// Dùng đúng hàm mà runtime dùng. Chép lại AES ở đây là tự tạo cơ hội lệch.

const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));
const { decryptSecret, encryptSecret, masterKeyEnvVar, parseMasterKey } = core;

const pnpmDir = resolve(ROOT, 'node_modules/.pnpm');
const postgresDir = readdirSync(pnpmDir).find((name) => /^postgres@\d/.test(name));
if (postgresDir === undefined) {
  console.error('không tìm thấy postgres trong node_modules/.pnpm — chạy pnpm install trước');
  process.exit(1);
}
const { default: postgres } = await import(
  resolve(pnpmDir, postgresDir, 'node_modules/postgres/src/index.js')
);

// ── kiểm tra khoá TRƯỚC khi chạm database ────────────────────────────────────
// Một vòng xoay dừng giữa chừng vì thiếu biến môi trường sẽ để lại database trộn lẫn hai phiên bản.

const targetVar = masterKeyEnvVar(TARGET_VERSION);
if ((process.env[targetVar] ?? '') === '') {
  console.error(`thiếu ${targetVar} — đặt khoá MỚI vào biến đó, giữ nguyên khoá cũ ở chỗ cũ`);
  process.exit(1);
}

let targetKey;
try {
  targetKey = parseMasterKey(process.env[targetVar], targetVar);
} catch (error) {
  console.error(`${targetVar} không hợp lệ: ${error instanceof Error ? error.message : 'lỗi'}`);
  process.exit(1);
}

if ((process.env.INFRA_MASTER_DATABASE_URL ?? '') === '') {
  console.error('thiếu INFRA_MASTER_DATABASE_URL');
  process.exit(1);
}

// ── bảng cần xoay ────────────────────────────────────────────────────────────
// `aad` nhận vào một dòng thô và dựng lại đúng ngữ cảnh mà mã cũ đã dùng khi mã hoá.

const TARGETS = [
  {
    table: 'infra_database_configs',
    id: 'id',
    ciphertext: 'encrypted_connection_string',
    nullable: false,
    aad: (row) => `${row.app_id}:${row.id}`,
    extraColumns: ['app_id'],
    hỏng: 'app con mất đường tới database của nó',
  },
  {
    table: 'infra_signing_keys',
    id: 'kid',
    ciphertext: 'encrypted_private_key',
    nullable: false,
    // `row.id` chứ không phải `row.kid`: câu select đặt bí danh `kid as id` cho mọi bảng, và AAD
    // dựng từ `row.kid` sẽ ra `signing-key:undefined` — giải mã hỏng sạch. Bài diễn tập bắt được.
    aad: (row) => `signing-key:${row.id}`,
    extraColumns: [],
    hỏng: 'không ký được JWT nào nữa',
  },
  {
    table: 'infra_webhook_endpoints',
    id: 'id',
    ciphertext: 'encrypted_secret',
    nullable: false,
    aad: (row) => `webhook:${row.id}`,
    extraColumns: [],
    hỏng: 'app con từ chối mọi webhook vì chữ ký sai',
  },
  {
    table: 'infra_mfa_factors',
    id: 'id',
    ciphertext: 'encrypted_secret',
    // WebAuthn không có seed — cột để trống là chuyện bình thường, không phải lỗi.
    nullable: true,
    aad: (row) => `mfa:${row.id}`,
    extraColumns: [],
    hỏng: 'người đã bật MFA bị khoá ngoài tài khoản của chính họ',
  },
];

// ── chạy ─────────────────────────────────────────────────────────────────────

// `sslmode=disable` là cách duy nhất tắt SSL, và phải viết ra trong DSN. Mặc định vẫn là bắt buộc:
// một lần diễn tập trên máy cục bộ không được phép nới lỏng lần chạy thật.
const dsn = process.env.INFRA_MASTER_DATABASE_URL;
const master = postgres(dsn, {
  ssl: /[?&]sslmode=disable/.test(dsn) ? false : 'require',
  max: 2,
  prepare: false,
});
const keyCache = new Map();

/** Khoá của một phiên bản cũ, nạp một lần, báo lỗi rõ ràng khi thiếu. */
function keyForVersion(version) {
  if (keyCache.has(version)) return keyCache.get(version);
  const name = masterKeyEnvVar(version);
  const raw = process.env[name] ?? '';
  if (raw === '') throw new Error(`thiếu ${name} (có dòng đang ở phiên bản ${version})`);
  const key = parseMasterKey(raw, name);
  keyCache.set(version, key);
  return key;
}

let totalRotated = 0;
let totalFailed = 0;
let ok = true;

try {
  say(`rotate-master-key · ${new Date().toISOString()}${DRY_RUN ? ' · --dry-run' : ''}`);
  say(`đích: phiên bản ${TARGET_VERSION} (${targetVar})`);
  say('');

  for (const target of TARGETS) {
    const rows = await master.unsafe(
      `select ${target.id} as id,
              ${target.ciphertext} as ciphertext,
              encryption_iv as iv,
              encryption_auth_tag as tag,
              coalesce(encryption_key_version, 1) as version
              ${target.extraColumns.map((c) => `, ${c}`).join('')}
       from ${target.table}
       where ${target.ciphertext} is not null`,
    );

    const stale = rows.filter((row) => Number(row.version) !== TARGET_VERSION);
    say(`${target.table}: ${rows.length} dòng có ciphertext, ${stale.length} dòng cần xoay`);

    if (stale.length === 0) continue;

    let rotated = 0;
    let failed = 0;

    for (const row of stale) {
      const aad = target.aad(row);
      const fromVersion = Number(row.version);

      let plaintext;
      try {
        plaintext = decryptSecret(
          { ciphertext: row.ciphertext, iv: row.iv, authTag: row.tag, keyVersion: fromVersion },
          aad,
          { key: keyForVersion(fromVersion) },
        );
      } catch (error) {
        // Không in id, không in lỗi gốc — lỗi driver có thể trích dẫn giá trị nó nhận được.
        failed += 1;
        continue;
      }

      if (DRY_RUN) {
        rotated += 1;
        continue;
      }

      const sealed = encryptSecret(plaintext, aad, { key: targetKey, keyVersion: TARGET_VERSION });

      // Một dòng, một UPDATE. Gộp cả bảng vào một transaction nghe gọn hơn nhưng khiến một dòng
      // hỏng kéo theo cả bảng quay lại — trong khi mỗi dòng ở đây độc lập hoàn toàn với dòng khác.
      // Ghi kèm `encryption_key_version = <cũ>` ở WHERE để hai lần chạy song song không đè nhau.
      const result = await master.unsafe(
        `update ${target.table}
            set ${target.ciphertext} = $1,
                encryption_iv = $2,
                encryption_auth_tag = $3,
                encryption_key_version = $4
          where ${target.id} = $5
            and coalesce(encryption_key_version, 1) = $6`,
        [sealed.ciphertext, sealed.iv, sealed.authTag, TARGET_VERSION, row.id, fromVersion],
      );

      if (result.count === 1) rotated += 1;
      else failed += 1;
    }

    totalRotated += rotated;
    totalFailed += failed;

    if (failed === 0) {
      say(`   ${DRY_RUN ? 'sẽ xoay' : 'đã xoay'} ${rotated}/${stale.length}`);
    } else {
      ok = false;
      say(`   FAIL ${failed}/${stale.length} dòng không mở được — ${target.hỏng}`);
      say('        → khoá cũ sai, hoặc dòng đó đã được mã hoá bằng một khoá khác nữa');
    }
  }

  say('');

  if (totalFailed > 0) {
    say(`🔴 ${totalFailed} dòng THẤT BẠI, ${totalRotated} dòng ${DRY_RUN ? 'sẽ xoay được' : 'đã xoay'}`);
    say('   ĐỪNG gỡ khoá cũ khỏi môi trường. Gỡ lúc này là biến lỗi sửa được thành mất dữ liệu.');
  } else if (DRY_RUN) {
    say(`🟡 thử khô: ${totalRotated} dòng mở được bằng khoá cũ và sẽ xoay được. Chưa ghi gì.`);
    say(`   chạy thật: node scripts/rotate-master-key.mjs --to ${TARGET_VERSION}`);
  } else {
    say(`🟢 đã xoay ${totalRotated} dòng sang phiên bản ${TARGET_VERSION}, không dòng nào hỏng`);
    say('');
    say('Còn hai bước nữa, theo đúng thứ tự:');
    say(`   1. Đặt INFRA_MASTER_ENCRYPTION_KEY_VERSION=${TARGET_VERSION} rồi khởi động lại ứng dụng.`);
    say('      Chưa đặt thì dòng MỚI vẫn được ghi bằng khoá cũ, và vòng xoay này chưa hoàn tất.');
    say('   2. Health check mọi app + đăng nhập thử một tài khoản có MFA. Xanh hết mới');
    say('      gỡ khoá cũ khỏi môi trường.');
  }
} catch (error) {
  ok = false;
  const message = error instanceof Error ? error.message : 'lỗi không rõ';
  say(`FAIL ${message.slice(0, 160)}`);
} finally {
  await master.end({ timeout: 5 });
}

writeLog(ok && totalFailed === 0);
