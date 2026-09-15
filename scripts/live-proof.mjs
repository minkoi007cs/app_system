/**
 * G0-4 — bằng chứng LIVE: một app con thật đọc dữ liệu thật qua policy thật.
 *
 * 503 test chứng minh từng mảnh đúng và đường nối khớp. Script này chứng minh thứ khác hẳn: rằng
 * **luật thực sự giữ được trên dữ liệu thật**. Nó chạy đúng đường mà `/api/v1/data/:resource` chạy
 * — parse → quyết định → biên dịch → thực thi — nhưng đầu kia là Master DB thật và database của
 * app con thật, không phải adapter giả.
 *
 * Viết bằng `.mjs` chứ không phải `.mts` có lý do: script này chạy trên VM Linux nối tới máy Khoi,
 * còn `node_modules` ở đó là bản darwin. `tsx` kéo theo `esbuild` là binary gốc nên không chạy
 * được; `postgres-js` và các gói `dist/` của dự án đều là JavaScript thuần nên chạy bình thường.
 *
 * Không in ra: connection string, khoá mã hoá, khoá API. Log chỉ có tên bảng, số dòng và phán quyết.
 *
 *   node scripts/live-proof.mjs            chạy và giữ lại dữ liệu chứng minh
 *   node scripts/live-proof.mjs --cleanup  chạy rồi xoá sạch bảng và policy đã tạo
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CLEANUP = process.argv.includes('--cleanup');
const RESOURCE = 'live_proof_notes';

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

for (const line of readFileSync(resolve(ROOT, '.env.local'), 'utf8').split('\n')) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (match === null) continue;
  if (process.env[match[1]] !== undefined) continue;
  process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
}

const lines = [];
const say = (line) => {
  console.info(line);
  lines.push(line);
};

function writeLog(ok) {
  mkdirSync(resolve(ROOT, 'logs'), { recursive: true });
  const name = `logs/live-proof-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  writeFileSync(resolve(ROOT, name), lines.join('\n') + '\n', 'utf8');
  console.info(`\nđã ghi ${name}`);
  process.exit(ok ? 0 : 1);
}

// ── nạp thư viện của chính dự án, không phải bản chép lại ────────────────────
// Nếu một trong những hàm dưới đây khác với hàm endpoint dùng thì bằng chứng này vô giá trị.

const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));
const { buildAad, compileDecision, compileQuerySpec, decide, decryptSecret, evaluateDecisionForRow, parseQuerySpec } = core;

// postgres-js là JavaScript thuần nên chạy được trên VM Linux dù node_modules là bản darwin.
// Đường dẫn có kèm version, nên dò thay vì ghi cứng — một lần `pnpm up` là số đó đổi.
const { readdirSync } = await import('node:fs');
const pnpmDir = resolve(ROOT, 'node_modules/.pnpm');
const postgresDir = readdirSync(pnpmDir).find((name) => /^postgres@\d/.test(name));
if (postgresDir === undefined) {
  console.error('không tìm thấy postgres trong node_modules/.pnpm — chạy pnpm install trước');
  process.exit(1);
}
const { default: postgres } = await import(
  resolve(pnpmDir, postgresDir, 'node_modules/postgres/src/index.js')
);

// ── chạy ─────────────────────────────────────────────────────────────────────

const master = postgres(process.env.INFRA_MASTER_DATABASE_URL, { ssl: 'require', max: 2, prepare: false });
let tenant = null;

try {
  say(`live-proof · ${new Date().toISOString()}${CLEANUP ? ' · --cleanup' : ''}`);

  // 1. chọn một app đã có database gắn vào
  const [app] = await master`
    select a.id, a.slug, c.id as config_id, c.provider,
           c.encrypted_connection_string, c.encryption_iv, c.encryption_auth_tag, c.encryption_key_version
    from infra_apps a
    join infra_database_configs c on c.app_id = a.id and c.is_primary = true
    where a.status = 'active'
    order by a.created_at
    limit 1`;

  if (app === undefined) {
    say('FAIL  không có app nào đang hoạt động kèm database — gắn một database trong Dashboard trước');
    writeLog(false);
  }
  say(`app: ${app.slug} · provider ${app.provider}`);

  // 2. giải mã DSN — đúng bằng cơ chế mà resolver dùng, kể cả AAD buộc theo dòng
  const dsn = decryptSecret(
    {
      ciphertext: app.encrypted_connection_string,
      iv: app.encryption_iv,
      authTag: app.encryption_auth_tag,
      keyVersion: app.encryption_key_version,
    },
    buildAad(app.id, app.config_id),
  );
  say('DSN: giải mã OK (AES-256-GCM, AAD buộc theo dòng) — không in ra');

  tenant = postgres(dsn, { ssl: 'require', max: 2, prepare: false });

  // 3. bảng chứng minh, tách riêng để không chạm vào thứ gì khác
  await tenant`
    create table if not exists ${tenant(RESOURCE)} (
      id serial primary key,
      owner_id text not null,
      title text not null
    )`;
  await tenant`delete from ${tenant(RESOURCE)}`;
  await tenant`
    insert into ${tenant(RESOURCE)} (owner_id, title) values
      ('user_alice', 'alice một'), ('user_alice', 'alice hai'), ('user_bob', 'bob riêng tư')`;
  say(`bảng ${RESOURCE}: 3 dòng (alice 2, bob 1)`);

  // 4. policy thật, ghi vào Master DB thật
  const condition = { op: 'eq', field: 'owner_id', value: { from: 'subject', path: 'id' } };
  for (const action of ['select', 'insert', 'update', 'delete']) {
    await master`
      insert into infra_policies (app_id, resource, action, effect, condition, priority, description)
      select ${app.id}, ${RESOURCE}, ${action}, 'allow', ${master.json(condition)}, 100,
             'live proof: mỗi người chỉ thấy dòng của chính mình'
      where not exists (
        select 1 from infra_policies
        where app_id = ${app.id} and resource = ${RESOURCE} and action = ${action})`;
  }
  const [{ n: policyCount }] = await master`
    select count(*)::int as n from infra_policies where app_id = ${app.id} and resource = ${RESOURCE}`;
  say(`policy: ${policyCount} bản ghi cho ${RESOURCE}`);

  const policyRows = await master`
    select id, resource, action, effect, condition, priority, enabled
    from infra_policies where app_id = ${app.id} and resource = ${RESOURCE}`;
  const policies = policyRows.map((row) => ({
    id: row.id,
    resource: row.resource,
    action: row.action,
    effect: row.effect,
    condition: row.condition,
    priority: row.priority,
    enabled: row.enabled,
  }));

  /** Đúng đường mà endpoint chạy: parse → quyết định → biên dịch → thực thi. */
  async function throughGateway(subjectId, payload, action = 'select') {
    const spec = parseQuerySpec(payload, RESOURCE);
    const subject = { id: subjectId, appId: app.id, roles: ['member'], workspaceId: null };
    const decision = decide(policies, { resource: spec.resource, action });

    const compiled = compileQuerySpec(spec, {
      dialect: 'postgres',
      condition: (startIndex, dialect) => compileDecision(decision, subject, dialect, startIndex),
    });

    const rows = await tenant.unsafe(compiled.sql, compiled.params);
    return { rows, sql: compiled.sql };
  }

  // ── 5. các phán quyết ──────────────────────────────────────────────────────
  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failures += 1;
    say(`${ok ? 'OK   ' : 'FAIL '} ${label}: ${actual} (kỳ vọng ${expected})`);
  };

  const alice = await throughGateway('user_alice', { select: ['id', 'title'] });
  check('alice thấy bao nhiêu dòng', alice.rows.length, 2);

  const bob = await throughGateway('user_bob', { select: ['id', 'title'] });
  check('bob thấy bao nhiêu dòng', bob.rows.length, 1);

  // Câu truy vấn trên không hề nhắc tới owner_id. Sự cách ly đến từ policy.
  say(`   câu lệnh alice: ${alice.sql}`);

  // Cố tình đòi dòng của người khác.
  const bobAttempt = await throughGateway('user_bob', {
    select: ['id', 'title'],
    filters: [{ column: 'owner_id', op: 'eq', value: 'user_alice' }],
  });
  check('bob đòi dòng của alice', bobAttempt.rows.length, 0);

  // Một chủ thể không có trong dữ liệu.
  const stranger = await throughGateway('user_nobody', { select: ['id'] });
  check('người lạ thấy bao nhiêu dòng', stranger.rows.length, 0);

  // Bảng không có policy nào → mặc định từ chối, biên dịch ra điều kiện không bao giờ đúng.
  const deniedSpec = parseQuerySpec({ resource: 'infra_secrets_that_do_not_exist' });
  const deniedDecision = decide(policies, { resource: deniedSpec.resource, action: 'select' });
  const deniedSql = compileQuerySpec(deniedSpec, {
    dialect: 'postgres',
    condition: (i, d) => compileDecision(deniedDecision, { id: 'user_alice', appId: app.id, roles: [], workspaceId: null }, d, i),
  }).sql;
  check('tài nguyên không có policy sinh ra 1 = 0', deniedSql.includes('(1 = 0)'), true);

  // INSERT: không có WHERE để gắn điều kiện, nên policy chấm thẳng trên dòng.
  const insertDecision = decide(policies, { resource: RESOURCE, action: 'insert' });
  const bobSubject = { id: 'user_bob', appId: app.id, roles: ['member'], workspaceId: null };
  check(
    'bob chèn dòng mang tên alice',
    evaluateDecisionForRow(insertDecision, bobSubject, { owner_id: 'user_alice', title: 'x' }).satisfied,
    false,
  );
  check(
    'bob chèn dòng bỏ trống owner_id',
    evaluateDecisionForRow(insertDecision, bobSubject, { title: 'x' }).undecidable.includes('owner_id'),
    true,
  );
  check(
    'bob chèn dòng của chính mình',
    evaluateDecisionForRow(insertDecision, bobSubject, { owner_id: 'user_bob', title: 'x' }).satisfied,
    true,
  );

  // UPDATE có điều kiện policy AND vào, nên bob không sửa được dòng của alice.
  const updated = await throughGateway(
    'user_bob',
    { action: 'update', values: { title: 'bị chiếm' }, filters: [{ column: 'owner_id', op: 'eq', value: 'user_alice' }] },
    'update',
  );
  check('bob sửa dòng của alice', updated.rows.length, 0);

  const [{ n: intact }] = await tenant`select count(*)::int as n from ${tenant(RESOURCE)} where title = 'bị chiếm'`;
  check('số dòng bị đổi tên sau khi bob thử', intact, 0);

  // ── 6. dọn dẹp ─────────────────────────────────────────────────────────────
  if (CLEANUP) {
    await tenant`drop table if exists ${tenant(RESOURCE)}`;
    await master`delete from infra_policies where app_id = ${app.id} and resource = ${RESOURCE}`;
    say('đã dọn: bảng và policy của bài chứng minh đã xoá');
  } else {
    say(`giữ lại ${RESOURCE} và ${policyCount} policy — chạy lại kèm --cleanup để xoá`);
  }

  say(failures === 0 ? '\n🟢 TẤT CẢ PHÁN QUYẾT ĐÚNG — luật giữ được trên dữ liệu thật' : `\n🔴 ${failures} phán quyết SAI`);
  writeLog(failures === 0);
} catch (error) {
  // Rút gọn: lỗi từ driver có thể trích dẫn DSN nó nhận được.
  const message = error instanceof Error ? error.message : 'unknown';
  say(`FAIL  ${message.slice(0, 160)}`);
  writeLog(false);
} finally {
  await master.end().catch(() => {});
  if (tenant !== null) await tenant.end().catch(() => {});
}
