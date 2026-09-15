/**
 * Gieo dữ liệu cho bài diễn tập xoay khoá — CHỈ dùng trên database vứt đi.
 *
 * Tạo mỗi bảng mang ciphertext một vài dòng, mã hoá bằng khoá phiên bản 1, với đúng AAD mà mã
 * thật dùng. Sau đó `rotate-master-key.mjs` có thứ để xoay, và `drill-verify.mjs` có thứ để kiểm.
 *
 * Từ chối chạy nếu DSN không phải localhost hoặc không có tên chứa `drill`: script này ghi vào
 * bốn bảng nhạy cảm nhất của hệ thống, và một lần chạy nhầm vào Master DB thật là không hoàn tác được.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

if (!/127\.0\.0\.1|localhost/.test(dsn) || !/drill/.test(dsn)) {
  console.error('từ chối: chỉ chạy trên database cục bộ có chữ "drill" trong tên');
  process.exit(1);
}

const { buildAad, encryptSecret, parseMasterKey } = await import(
  resolve(ROOT, 'packages/core/dist/index.js')
);

const pnpmDir = resolve(ROOT, 'node_modules/.pnpm');
const postgresDir = readdirSync(pnpmDir).find((name) => /^postgres@\d/.test(name));
const { default: postgres } = await import(
  resolve(pnpmDir, postgresDir, 'node_modules/postgres/src/index.js')
);

const key = parseMasterKey(process.env.INFRA_MASTER_ENCRYPTION_KEY);
const seal = (plaintext, aad) => encryptSecret(plaintext, aad, { key, keyVersion: 1 });

const sql = postgres(dsn, { ssl: false, max: 2, prepare: false });

const userId = `drill-user-${randomUUID()}`;
await sql`insert into "user" (id, name, email) values (${userId}, 'Drill User', ${`${userId}@drill.invalid`})`;

const appIds = [];
for (let i = 0; i < 3; i += 1) {
  const [app] = await sql`
    insert into infra_apps (slug, name, owner_user_id)
    values (${`drill-app-${i}-${randomUUID().slice(0, 8)}`}, ${`Drill App ${i}`}, ${userId})
    returning id`;
  appIds.push(app.id);
}

// ── infra_database_configs ───────────────────────────────────────────────────
for (const [i, appId] of appIds.entries()) {
  const configId = randomUUID();
  const dsnPlain = `postgresql://u:p@drill-${i}.invalid/db?sslmode=require`;
  const sealed = seal(dsnPlain, buildAad(appId, configId));
  await sql`
    insert into infra_database_configs
      (id, app_id, provider, dialect, label, encrypted_connection_string,
       encryption_iv, encryption_auth_tag, encryption_key_version)
    values (${configId}, ${appId}, 'neon', 'postgres', ${`drill-${i}`},
            ${sealed.ciphertext}, ${sealed.iv}, ${sealed.authTag}, 1)`;
}

// ── infra_signing_keys ───────────────────────────────────────────────────────
for (let i = 0; i < 2; i += 1) {
  const kid = `drill-kid-${randomUUID().slice(0, 12)}`;
  const sealed = seal(`-----BEGIN PRIVATE KEY-----drill-${i}-----END PRIVATE KEY-----`, `signing-key:${kid}`);
  await sql`
    insert into infra_signing_keys
      (kid, public_jwk, encrypted_private_key, encryption_iv, encryption_auth_tag, encryption_key_version)
    values (${kid}, ${sql.json({ kty: 'EC', crv: 'P-256' })}, ${sealed.ciphertext},
            ${sealed.iv}, ${sealed.authTag}, 1)`;
}

// ── infra_webhook_endpoints ──────────────────────────────────────────────────
for (const [i, appId] of appIds.entries()) {
  const endpointId = randomUUID();
  const sealed = seal(`whsec_drill_${i}_${randomUUID().slice(0, 8)}`, `webhook:${endpointId}`);
  await sql`
    insert into infra_webhook_endpoints
      (id, app_id, url, encrypted_secret, encryption_iv, encryption_auth_tag, encryption_key_version)
    values (${endpointId}, ${appId}, ${`https://drill-${i}.invalid/hook`},
            ${sealed.ciphertext}, ${sealed.iv}, ${sealed.authTag}, 1)`;
}

// ── infra_mfa_factors ────────────────────────────────────────────────────────
// Một factor TOTP có seed, một factor WebAuthn KHÔNG có — cột null là hợp lệ, và vòng xoay phải
// bỏ qua nó chứ không được coi là hỏng.
{
  const factorId = randomUUID();
  const sealed = seal('JBSWY3DPEHPK3PXP', buildAad('mfa', factorId));
  await sql`
    insert into infra_mfa_factors (id, user_id, type, label, encrypted_secret,
                                   encryption_iv, encryption_auth_tag, encryption_key_version)
    values (${factorId}, ${userId}, 'totp', 'Drill TOTP',
            ${sealed.ciphertext}, ${sealed.iv}, ${sealed.authTag}, 1)`;

  await sql`
    insert into infra_mfa_factors (id, user_id, type, label)
    values (${randomUUID()}, ${userId}, 'webauthn', 'Drill Passkey')`;
}

const counts = {};
for (const table of ['infra_database_configs', 'infra_signing_keys', 'infra_webhook_endpoints', 'infra_mfa_factors']) {
  const [row] = await sql.unsafe(`select count(*)::int as n from ${table}`);
  counts[table] = row.n;
}

console.info('đã gieo (phiên bản khoá 1):');
for (const [table, n] of Object.entries(counts)) console.info(`  ${table}: ${n}`);

await sql.end({ timeout: 5 });
