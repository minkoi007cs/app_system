/**
 * Kiểm sau khi xoay khoá — CHỈ trên database diễn tập.
 *
 * `rotate-master-key.mjs` tự báo cáo nó đã xoay bao nhiêu dòng. Script này không tin con số đó:
 * nó mở lại từng dòng bằng **khoá mới**, và xác nhận **khoá cũ không còn mở được nữa**. Một vòng
 * xoay mà khoá cũ vẫn mở được nghĩa là chưa xoay thật, chỉ ghi đè phiên bản.
 *
 * Không in ra plaintext. Chỉ đếm.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
const expectedVersion = Number(process.env.DRILL_EXPECT_VERSION ?? '2');

if (!/127\.0\.0\.1|localhost/.test(dsn) || !/drill/.test(dsn)) {
  console.error('từ chối: chỉ chạy trên database cục bộ có chữ "drill" trong tên');
  process.exit(1);
}

const { decryptSecret, parseMasterKey } = await import(resolve(ROOT, 'packages/core/dist/index.js'));

const pnpmDir = resolve(ROOT, 'node_modules/.pnpm');
const postgresDir = readdirSync(pnpmDir).find((name) => /^postgres@\d/.test(name));
const { default: postgres } = await import(
  resolve(pnpmDir, postgresDir, 'node_modules/postgres/src/index.js')
);

const oldKey = parseMasterKey(process.env.DRILL_OLD_KEY);
const newKey = parseMasterKey(process.env.DRILL_NEW_KEY);
const sql = postgres(dsn, { ssl: false, max: 2, prepare: false });

const TARGETS = [
  { table: 'infra_database_configs', id: 'id', col: 'encrypted_connection_string', extra: 'app_id', aad: (r) => `${r.app_id}:${r.id}` },
  { table: 'infra_signing_keys', id: 'kid', col: 'encrypted_private_key', extra: null, aad: (r) => `signing-key:${r.id}` },
  { table: 'infra_webhook_endpoints', id: 'id', col: 'encrypted_secret', extra: null, aad: (r) => `webhook:${r.id}` },
  { table: 'infra_mfa_factors', id: 'id', col: 'encrypted_secret', extra: null, aad: (r) => `mfa:${r.id}` },
];

let failures = 0;
let checked = 0;

for (const t of TARGETS) {
  const rows = await sql.unsafe(
    `select ${t.id} as id, ${t.col} as ciphertext, encryption_iv as iv, encryption_auth_tag as tag,
            coalesce(encryption_key_version, 1) as version${t.extra ? `, ${t.extra}` : ''}
     from ${t.table} where ${t.col} is not null`,
  );

  let openedByNew = 0;
  let stillOpenedByOld = 0;
  let wrongVersion = 0;

  for (const row of rows) {
    checked += 1;
    const envelope = { ciphertext: row.ciphertext, iv: row.iv, authTag: row.tag, keyVersion: Number(row.version) };
    if (Number(row.version) !== expectedVersion) wrongVersion += 1;

    try {
      decryptSecret(envelope, t.aad(row), { key: newKey });
      openedByNew += 1;
    } catch {
      /* đếm ở dưới */
    }
    try {
      decryptSecret(envelope, t.aad(row), { key: oldKey });
      stillOpenedByOld += 1;
    } catch {
      /* đúng như mong đợi */
    }
  }

  const ok = openedByNew === rows.length && stillOpenedByOld === 0 && wrongVersion === 0;
  if (!ok) failures += 1;

  console.info(
    `${ok ? 'OK  ' : 'FAIL'}  ${t.table}: ${openedByNew}/${rows.length} mở bằng khoá mới · ` +
      `${stillOpenedByOld} còn mở bằng khoá cũ (kỳ vọng 0) · ${wrongVersion} sai phiên bản (kỳ vọng 0)`,
  );
}

await sql.end({ timeout: 5 });

console.info('');
console.info(
  failures === 0
    ? `🟢 ${checked} dòng đã sang khoá mới, khoá cũ không mở được dòng nào`
    : `🔴 ${failures} bảng chưa đạt`,
);
process.exit(failures === 0 ? 0 : 1);
