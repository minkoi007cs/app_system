#!/usr/bin/env bash
#
# Cài hai lịch chạy định kỳ vào crontab của người dùng hiện tại (G1-3, self-host).
#
# Trên Vercel thì KHÔNG cần script này — `vercel.json` ở gốc repo đã khai báo sẵn hai cron đó,
# và Vercel gửi `Authorization: Bearer $CRON_SECRET`, nên chỉ cần đặt `INFRA_INTERNAL_TOKEN`
# bằng đúng `CRON_SECRET`.
#
# Script này idempotent: chạy nhiều lần không nhân đôi dòng. Nó nhận diện dòng của mình bằng
# một marker trong comment, và thay thế đúng khối đó.
#
#   ./scripts/install-cron.sh                     cài, trỏ vào http://localhost:3000
#   ./scripts/install-cron.sh https://infra.abc    cài, trỏ vào URL khác
#   ./scripts/install-cron.sh --remove             gỡ
#
# Token KHÔNG nằm trong crontab. Crontab là file văn bản thường, mọi tiến trình của người dùng
# đều đọc được; một `ps` đúng lúc cũng thấy được dòng lệnh. Thay vào đó dòng cron đọc token từ
# `~/.config/unified-app-infra/internal-token` với quyền 600.

set -euo pipefail

MARKER="# unified-app-infra"
TOKEN_FILE="${HOME}/.config/unified-app-infra/internal-token"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--remove" ]]; then
  crontab -l 2>/dev/null | grep -v -F "${MARKER}" | crontab - || true
  echo "đã gỡ lịch chạy của unified-app-infra khỏi crontab"
  exit 0
fi

BASE_URL="${1:-http://localhost:3000}"

# ── token ────────────────────────────────────────────────────────────────────

if [[ ! -f "${ROOT}/.env.local" ]]; then
  echo "không tìm thấy .env.local ở ${ROOT}" >&2
  exit 1
fi

TOKEN="$(sed -n 's/^INFRA_INTERNAL_TOKEN=["'\'']\{0,1\}\([^"'\''[:space:]]*\).*/\1/p' "${ROOT}/.env.local" | head -1)"

if [[ -z "${TOKEN}" ]]; then
  echo "INFRA_INTERNAL_TOKEN chưa có trong .env.local" >&2
  echo "sinh một cái:  openssl rand -base64 48" >&2
  exit 1
fi

mkdir -p "$(dirname "${TOKEN_FILE}")"
umask 077
printf '%s' "${TOKEN}" > "${TOKEN_FILE}"
chmod 600 "${TOKEN_FILE}"
unset TOKEN

# ── crontab ──────────────────────────────────────────────────────────────────
#
# `-f` để curl trả mã lỗi khi HTTP 4xx/5xx. Không có nó, cron im lặng coi mọi lần 401 là thành
# công — đúng kiểu hỏng mà lịch chạy sinh ra để tránh.
# stderr đi vào file log để một endpoint hỏng còn để lại dấu vết; stdout bỏ đi.

CURL='curl -fsS -m 30 -X POST -H "Authorization: Bearer $(cat '"${TOKEN_FILE}"')"'
LOG="${HOME}/.local/state/unified-app-infra"
mkdir -p "${LOG}"

BLOCK=$(cat <<EOF
${MARKER} — gỡ bằng: ./scripts/install-cron.sh --remove
* * * * * ${CURL} ${BASE_URL}/api/internal/webhooks/drain >/dev/null 2>>${LOG}/drain.err ${MARKER}
0 * * * * ${CURL} ${BASE_URL}/api/internal/maintenance >/dev/null 2>>${LOG}/maintenance.err ${MARKER}
EOF
)

{ crontab -l 2>/dev/null | grep -v -F "${MARKER}" || true; echo "${BLOCK}"; } | crontab -

echo "đã cài lịch chạy, trỏ vào ${BASE_URL}"
echo "  webhooks/drain  mỗi phút"
echo "  maintenance     mỗi giờ"
echo "  token đọc từ    ${TOKEN_FILE} (quyền 600, không nằm trong crontab)"
echo "  lỗi ghi vào     ${LOG}/"
echo ""
echo "kiểm tra:  crontab -l | grep unified-app-infra"
echo "thử tay:   curl -fsS -X POST -H \"Authorization: Bearer \$(cat ${TOKEN_FILE})\" ${BASE_URL}/api/internal/maintenance"
