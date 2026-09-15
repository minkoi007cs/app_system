/**
 * Vì sao hai dòng trong `infra_database_configs` không mở được.
 *
 * `rotate-master-key.mjs --dry-run` báo 2/4 dòng FAIL và cố tình **không** nói dòng nào: nó là
 * công cụ ghi dữ liệu, và một công cụ ghi dữ liệu in id ra log là một công cụ rò rỉ. Nhưng "hỏng,
 * không biết dòng nào" là chỗ tệ nhất để dừng lại, nên đây là công cụ đọc — chỉ đọc — đi trả lời
 * đúng câu đó.
 *
 * Nó phân biệt hai nguyên nhân hoàn toàn khác nhau, mà từ bên ngoài trông giống hệt nhau:
 *
 *   SAI KHOÁ  — ciphertext được niêm bằng một khoá khác. Dữ liệu coi như mất; chỉ khôi phục được
 *               nếu tìm lại khoá cũ đó.
 *   SAI AAD   — khoá đúng, nhưng chuỗi ràng buộc không khớp. Dữ liệu còn nguyên vẹn, và sửa được
 *               bằng cách niêm lại đúng ràng buộc.
 *
 * Cách phân biệt: thử giải mã cùng một ciphertext với vài dạng AAD khác nhau. Nếu một dạng mở
 * được thì khoá đúng và vấn đề nằm ở ràng buộc. Nếu không dạng nào mở được thì là khoá.
 *
 * KHÔNG in ra: connection string, khoá, ciphertext, IV, auth tag. Chỉ slug app, provider, nhãn,
 * ngày tạo, và phán quyết.
 *
 *   node scripts/diagnose-configs.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));
const { decryptSecret, parseMasterKey, masterKeyEnvVar } = core;

const pnpmDir = resolve(ROOT, 'node_modules/.pnpm');
const postgresDir = readdirSync(pnpmDir).find((name) => /^postgres@\d/.test(name));
if (postgresDir === undefined) {
  console.error('không tìm thấy postgres trong node_modules/.pnpm — chạy pnpm install trước');
  process.exit(1);
}
const { default: postgres } = await import(
  resolve(pnpmDir, postgresDir, 'node_modules/postgres/src/index.js')
);

/** Mọi khoá đang có trong môi trường, theo phiên bản. Dòng nào mở được bằng khoá nào cũng đáng biết. */
const keys = new Map();
for (let version = 1; version <= 9; version += 1) {
  const raw = process.env[masterKeyEnvVar(version)] ?? '';
  if (raw !== '') {
    try {
      keys.set(version, parseMasterKey(raw));
    } catch {
      say(`cảnh báo: ${masterKeyEnvVar(version)} có mặt nhưng không phải 64 ký tự hex — bỏ qua`);
    }
  }
}

if (keys.size === 0) {
  console.error('không có khoá nào trong môi trường — kiểm .env.local');
  process.exit(1);
}

const dsn = process.env['INFRA_MASTER_DATABASE_URL'] ?? '';
if (dsn === '') {
  console.error('thiếu INFRA_MASTER_DATABASE_URL');
  process.exit(1);
}

const master = postgres(dsn, { max: 1, onnotice: () => {} });

/** Ngày, không có giờ phút — đủ để xếp thứ tự, không đủ để làm dấu vân tay. */
const day = (value) => (value === null || value === undefined ? '?' : new Date(value).toISOString().slice(0, 10));

let ok = true;

try {
  say(`diagnose-configs · ${new Date().toISOString()}`);
  say(`khoá có trong môi trường: phiên bản ${[...keys.keys()].join(', ')}`);
  say('');

  const rows = await master.unsafe(
    `select c.id                     as id,
            c.app_id                 as app_id,
            a.slug                   as slug,
            c.provider               as provider,
            c.label                  as label,
            c.is_primary             as is_primary,
            c.created_at             as created_at,
            c.encrypted_connection_string as ciphertext,
            c.encryption_iv          as iv,
            c.encryption_auth_tag    as tag,
            coalesce(c.encryption_key_version, 1) as version
       from infra_database_configs c
       left join infra_apps a on a.id = c.app_id
      where c.encrypted_connection_string is not null
      order by c.created_at`,
  );

  say(`${rows.length} dòng có ciphertext`);
  say('');

  for (const row of rows) {
    // Các dạng AAD đáng thử. Dạng đầu là dạng đúng theo `buildAad(appId, configId)`; các dạng sau
    // là những nhầm lẫn có thật mà một lần chèn tay hay một script cũ có thể tạo ra.
    const candidates = [
      ['đúng chuẩn  app_id:config_id', `${row.app_id}:${row.id}`],
      ['chỉ config_id', `${row.id}`],
      ['chỉ app_id', `${row.app_id}`],
      ['đảo ngược   config_id:app_id', `${row.id}:${row.app_id}`],
      ['rỗng', ''],
    ];

    let verdict = null;

    outer: for (const [version, key] of keys) {
      for (const [name, aad] of candidates) {
        try {
          decryptSecret(
            { ciphertext: row.ciphertext, iv: row.iv, authTag: row.tag, keyVersion: version },
            aad,
            { key },
          );
          verdict = { version, name };
          break outer;
        } catch {
          // không mở được với tổ hợp này — thử tổ hợp kế tiếp
        }
      }
    }

    const who = `${row.slug ?? '(app đã xoá)'} · ${row.provider} · ${row.label ?? '—'}${row.is_primary ? ' · primary' : ''}`;
    const when = `tạo ${day(row.created_at)} · cột version=${row.version}`;

    if (verdict === null) {
      ok = false;
      say(`FAIL  ${who}`);
      say(`      ${when}`);
      say(`      không khoá nào, không dạng AAD nào mở được → ciphertext thuộc về một khoá khác`);
    } else if (verdict.name.startsWith('đúng chuẩn') && verdict.version === row.version) {
      say(`OK    ${who}`);
      say(`      ${when}`);
    } else {
      ok = false;
      say(`LỆCH  ${who}`);
      say(`      ${when}`);
      say(`      mở được bằng khoá phiên bản ${verdict.version}, AAD dạng "${verdict.name}"`);
      say(`      → dữ liệu CÒN NGUYÊN, chỉ sai ràng buộc. Niêm lại đúng chuẩn là xong.`);
    }
    say('');
  }

  say(ok ? '🟢 mọi dòng mở được đúng chuẩn' : '🔴 có dòng không đúng chuẩn — xem từng dòng ở trên');
} catch (error) {
  ok = false;
  // Message đã rút gọn: lỗi driver có thể trích dẫn lại DSN nó vừa nhận.
  say(`FAIL  ${(error instanceof Error ? error.message : 'lỗi không rõ').slice(0, 160)}`);
} finally {
  await master.end({ timeout: 5 });
}

mkdirSync(resolve(ROOT, 'logs'), { recursive: true });
const name = `logs/diagnose-configs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
writeFileSync(resolve(ROOT, name), lines.join('\n') + '\n', 'utf8');
console.info(`\nđã ghi ${name}`);
process.exit(ok ? 0 : 1);
