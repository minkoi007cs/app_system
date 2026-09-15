/**
 * Bằng chứng cho việc gửi mail thật — G0-2, mảnh cuối chặn v1.0.
 *
 * Luồng khôi phục mật khẩu là chỗ duy nhất trong hệ thống mà **gửi hỏng không phân biệt được với
 * bị tấn công**, từ phía người dùng: họ bấm quên mật khẩu, không thấy gì tới, và không có cách nào
 * biết là thư chậm, địa chỉ sai, hay ai đó đã chiếm tài khoản. Nên "đã cấu hình" không đủ; phải có
 * một lá thư thật tới một hộp thư thật.
 *
 * Script này chạy trên máy có `.env.local` — khoá API không đi đâu khác. Nó dùng đúng transport mà
 * runtime dùng (`createMailTransport` trong `@infra/core`), không phải một lệnh gọi HTTP viết lại:
 * nếu hai thứ đó khác nhau thì bằng chứng này vô giá trị.
 *
 *   node scripts/mail-proof.mjs you@example.com
 *
 * Với `INFRA_MAIL_FROM=onboarding@resend.dev`, Resend **chỉ gửi tới email đã đăng ký tài khoản
 * Resend**. Gửi tới địa chỉ khác sẽ bị từ chối, và đó là hành vi của Resend chứ không phải lỗi ở
 * đây — muốn gửi cho người khác thì phải verify một domain riêng.
 *
 * Không in ra: khoá API, nội dung thư đầy đủ, địa chỉ chưa che.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// Nạp `.env.local`. Biến có sẵn trong môi trường thắng biến trong file.
const envPath = resolve(ROOT, '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    if (process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
}

const recipient = process.argv[2] ?? '';
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
  console.error('dùng: node scripts/mail-proof.mjs <email nhận thư>');
  console.error('với onboarding@resend.dev thì phải là email đã đăng ký tài khoản Resend');
  process.exit(1);
}

const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));
const { createMailTransport, mailConfigFromEnv, maskEmail, InfraError } = core;

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

say(`mail-proof · ${new Date().toISOString()}`);
say(`gửi tới: ${maskEmail(recipient)}`);
say('');

// ── 1. cấu hình chọn đúng transport ─────────────────────────────────────────
const config = mailConfigFromEnv();
const transport = createMailTransport(config);

check('transport được chọn theo INFRA_MAIL_PROVIDER', transport.name, 'resend');
check('có API key', (config.apiKey ?? '') !== '', true);
check('có địa chỉ gửi', (config.from ?? '') !== '', true);

if (transport.name === 'unconfigured') {
  say('');
  say('🔴 chưa cấu hình được transport — kiểm INFRA_MAIL_PROVIDER trong .env.local');
  process.exit(1);
}

// ── 2. cấu hình thiếu phải ném lỗi TRƯỚC khi gọi mạng ───────────────────────
// Kiểm bằng một transport dựng riêng, không chạm cấu hình thật.
let halfConfigRefused = false;
try {
  await createMailTransport({ provider: 'resend', apiKey: 'k' }).send({
    to: recipient,
    subject: 'x',
    text: 'x',
  });
} catch (error) {
  halfConfigRefused = InfraError.is(error) && /INFRA_MAIL_FROM/.test(error.message);
}
check('thiếu INFRA_MAIL_FROM thì từ chối trước khi gọi mạng', halfConfigRefused, true);

// ── 3. gửi thật ─────────────────────────────────────────────────────────────
const token = `proof_${Math.random().toString(36).slice(2, 10)}`;
const link = `${process.env.INFRA_PUBLIC_URL ?? 'http://localhost:3000'}/recover?token=${token}`;

let sendError = null;
const started = Date.now();
try {
  await transport.send({
    to: recipient,
    subject: 'Unified-App-Infra — kiểm tra đường gửi mail',
    text:
      'Đây là thư kiểm tra do scripts/mail-proof.mjs gửi.\n\n' +
      'Nếu bạn nhận được thư này thì luồng khôi phục mật khẩu đã gửi được thật.\n\n' +
      `Link giả lập (không dùng được): ${link}\n`,
  });
} catch (error) {
  sendError = error;
}
const elapsed = Date.now() - started;

if (sendError === null) {
  check('gửi thật qua Resend thành công', true, true);
  say(`      mất ${elapsed}ms`);
} else {
  failures += 1;
  // Chỉ message đã rút gọn: InfraError của mailer cố ý KHÔNG mang body của provider, vì body đó
  // có thể trích dẫn lại chính địa chỉ người nhận.
  const message = sendError instanceof Error ? sendError.message : 'lỗi không rõ';
  say(`FAIL  gửi thật qua Resend: ${message.slice(0, 160)}`);
  const status = InfraError.is(sendError) ? sendError.details.status : undefined;
  if (status !== undefined) say(`      HTTP ${status} từ provider`);
  if (status === 403 || status === 422) {
    say('      → với onboarding@resend.dev, Resend chỉ gửi tới email đã đăng ký tài khoản.');
    say('        Thử lại với đúng email đó, hoặc verify một domain riêng trong Resend.');
  }
  if (status === 401) say('      → khoá API bị từ chối. Kiểm lại INFRA_MAIL_API_KEY.');
}

// ── 3b. chẩn đoán khi thất bại ──────────────────────────────────────────────
//
// Transport của production cố tình **không** giữ body lỗi của provider: body đó có thể trích dẫn
// lại chính lá thư nó vừa nhận, kể cả địa chỉ người nhận, và thứ đó không được lọt vào một
// InfraError có thể bị log. Quyết định đó đúng — nhưng nó cũng làm một lần 403 trở thành không
// chẩn đoán được, và "không gửi được, không biết vì sao" là trạng thái tệ nhất để dừng lại.
//
// Nên script này — một công cụ chẩn đoán do chính chủ tài khoản chạy, không phải mã production —
// tự gọi một lần nữa và đọc lời giải thích của provider, **sau khi che mọi địa chỉ email** trong
// đó. Đủ để biết tài khoản nào, không đủ để thu hoạch địa chỉ từ log.
if (sendError !== null) {
  say('');
  say('── chẩn đoán: provider nói gì ──');
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ from: config.from, to: [recipient], subject: 'probe', text: 'probe' }),
    });
    const raw = await response.text();
    const masked = raw.replace(/[^\s"'<>,]+@[^\s"'<>,]+/g, (address) => maskEmail(address));
    say(`HTTP ${response.status}: ${masked.slice(0, 400)}`);
  } catch (probeError) {
    say(`không đọc được lời giải thích: ${probeError instanceof Error ? probeError.message.slice(0, 120) : '?'}`);
  }
}

// ── 4. lỗi KHÔNG được mang địa chỉ người nhận ───────────────────────────────
// Một provider trả lỗi có thể trích dẫn lại thư nó vừa nhận. Nếu lỗi đó bị log, địa chỉ rò ra.
if (sendError !== null && InfraError.is(sendError)) {
  const serialised = JSON.stringify(sendError.toJSON());
  check('lỗi không chứa địa chỉ người nhận', serialised.includes(recipient), false);
}

say('');
say(
  failures === 0
    ? '🟢 ĐƯỜNG GỬI MAIL HOẠT ĐỘNG — kiểm hộp thư để xác nhận thư đã tới'
    : `🔴 ${failures} khẳng định SAI`,
);

mkdirSync(resolve(ROOT, 'logs'), { recursive: true });
const name = `logs/mail-proof-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
writeFileSync(resolve(ROOT, name), lines.join('\n') + '\n', 'utf8');
console.info(`\nđã ghi ${name}`);
process.exit(failures === 0 ? 0 : 1);
