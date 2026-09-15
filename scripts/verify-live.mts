/**
 * Kiểm tra Master DB thật đang ở trạng thái nào, rồi ghi một log **đã che dữ liệu nhạy cảm**.
 *
 * Tồn tại vì hai bên không nhìn thấy cùng một thứ: egress tới Neon bị chặn ở phía Claude, nên câu
 * "đã chạy xong" không kiểm chứng được từ xa. Script này chạy ở máy Khoi, và log của nó là bằng
 * chứng — không phải lời kể.
 *
 * Không in ra: connection string, khoá API, email, bất kỳ giá trị nào của một dòng dữ liệu. Chỉ in
 * tên bảng, số đếm, và tên migration.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { countAppliedMigrations, countRows, listPublicTables, masterDb } from '@infra/db';

/**
 * Nạp `.env.local` giống script smoke.
 *
 * Biến đã có sẵn trong môi trường **thắng** biến trong file: chạy một lần với biến tạm ở dòng lệnh
 * không được phép bị file ghi đè lên trong im lặng.
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
  }
}

function findRepoRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    current = dirname(current);
  }
  return process.cwd();
}

loadEnvFile(resolve(findRepoRoot(), '.env.local'));

const EXPECTED_TABLES = [
  // 0000 — nền tảng
  'infra_apps',
  'infra_api_keys',
  'infra_database_configs',
  'infra_audit_logs',
  'infra_app_members',
  'user',
  'session',
  'account',
  'verification',
  // 0001–0006
  'infra_signing_keys',
  'infra_refresh_tokens',
  'infra_platform_admins',
  'infra_mfa_factors',
  'infra_trusted_devices',
  'infra_webauthn_challenges',
  'infra_roles',
  'infra_role_assignments',
  'infra_policies',
  'infra_workspaces',
  'infra_workspace_members',
  'infra_user_lifecycle',
  'infra_invitations',
  'infra_service_accounts',
  // 0007–0011 — những bảng mà câu hỏi "migrate xong chưa" thực sự nói về
  'infra_login_attempts',
  'infra_recovery_tokens',
  'infra_webhook_endpoints',
  'infra_webhook_deliveries',
  'infra_provisioned_resources',
  'infra_provider_quotas',
  'infra_impersonation_sessions',
  'infra_rate_limits',
];

async function main(): Promise<void> {
  if ((process.env['INFRA_MASTER_DATABASE_URL'] ?? '') === '') {
    console.error('FAIL  thiếu INFRA_MASTER_DATABASE_URL — chạy trong thư mục repo có .env.local');
    process.exit(1);
  }

  const db = masterDb();
  const lines: string[] = [];
  const say = (line: string): void => {
    console.info(line);
    lines.push(line);
  };

  say(`verify-live · ${new Date().toISOString()}`);

  // ── bảng ───────────────────────────────────────────────────────────────────
  const present = new Set(await listPublicTables(db));
  const missing = EXPECTED_TABLES.filter((name) => !present.has(name));

  say(`tables: ${present.size} có mặt, kỳ vọng tối thiểu ${EXPECTED_TABLES.length}`);

  if (missing.length === 0) {
    say('OK    đủ toàn bộ bảng — migration 0000→0011 đã apply');
  } else {
    say(`FAIL  thiếu ${missing.length} bảng: ${missing.join(', ')}`);
    say('      → chạy: pnpm db:migrate');
  }

  // ── migration journal của drizzle ──────────────────────────────────────────
  const applied = await countAppliedMigrations(db);
  say(
    applied === null
      ? 'migrations: chưa có bảng drizzle.__drizzle_migrations (chưa migrate lần nào?)'
      : `migrations đã ghi nhận: ${applied}`,
  );

  // ── một vài số đếm, không kèm dữ liệu ──────────────────────────────────────
  for (const table of ['infra_apps', 'infra_api_keys', 'infra_database_configs', 'infra_policies']) {
    if (!present.has(table)) continue;
    const n = await countRows(db, table);
    say(`${table}: ${n ?? 'không đọc được'} dòng`);
  }

  // ── cấu hình mail, chỉ báo có hay không ────────────────────────────────────
  const provider = process.env['INFRA_MAIL_PROVIDER'] ?? '';
  say(
    provider === ''
      ? 'mail: CHƯA cấu hình — luồng khôi phục mật khẩu sẽ ném lỗi (G0-2)'
      : `mail: provider=${provider}${provider === 'console' ? ' (chỉ dùng được ở dev)' : ''}`,
  );

  const internal = (process.env['INFRA_INTERNAL_TOKEN'] ?? '') === '' ? 'CHƯA đặt' : 'đã đặt';
  say(`INFRA_INTERNAL_TOKEN: ${internal}`);

  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('logs', { recursive: true });
  const path = `logs/verify-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');

  console.info(`\nđã ghi ${path}`);
  process.exit(missing.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  // Message rút gọn: lỗi từ driver có thể trích dẫn DSN nó nhận được.
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error('verify failed:', message.slice(0, 120));
  process.exit(1);
});
