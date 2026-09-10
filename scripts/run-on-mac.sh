#!/usr/bin/env bash
# Runs every step that needs real network access to Neon / Supabase / Turso.
# Must be run from the user's own Terminal — the Claude sandbox cannot reach these hosts.
#
#   bash scripts/run-on-mac.sh
#
# Writes a REDACTED log to logs/run-<timestamp>.log so Claude can read the outcome
# without ever seeing a key or a connection string.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p logs
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="logs/run-${STAMP}.log"

# Every line of output passes through this before hitting the log or the screen.
redact() {
  sed -E \
    -e 's#(postgres(ql)?://)[^[:space:]"]*#\1<REDACTED-DSN>#g' \
    -e 's#(libsql://)[^[:space:]"]*#\1<REDACTED-DSN>#g' \
    -e 's#napi_[A-Za-z0-9_-]+#<REDACTED-API-KEY>#g' \
    -e 's#(authToken=)[A-Za-z0-9._-]+#\1<REDACTED>#g' \
    -e 's#(pk_(live|test)_)[0-9A-Za-z]+#\1<REDACTED>#g' \
    -e 's#(INFRA_MASTER_ENCRYPTION_KEY=)[^[:space:]"]*#\1<REDACTED>#g' \
    -e 's#(BETTER_AUTH_SECRET=)[^[:space:]"]*#\1<REDACTED>#g' \
    -e 's#\b[0-9a-f]{64}\b#<REDACTED-HEX>#g'
}

step() { echo ""; echo "═══ $* ═══"; }
run()  { echo "\$ $*"; "$@" 2>&1; echo "  ↳ exit=$?"; }

main() {
  step "0 · toolchain"
  echo "node: $(node -v 2>&1)"
  echo "npm:  $(npm -v 2>&1)"
  command -v corepack >/dev/null && corepack enable >/dev/null 2>&1
  command -v pnpm >/dev/null || corepack prepare pnpm@9.12.0 --activate >/dev/null 2>&1
  echo "pnpm: $(pnpm -v 2>&1)"

  if [[ ! -f .secrets/neon.env ]]; then echo "❌ .secrets/neon.env missing"; return 1; fi
  set -a; source .secrets/neon.env; set +a
  [[ -f .secrets/tenants.env ]] && { set -a; source .secrets/tenants.env; set +a; }

  command -v neon >/dev/null || run npm i -g neon@latest
  echo "neon: $(neon --version 2>&1)"

  step "1 · who am I"
  run neon me

  step "2 · skills";  run neon skills -y
  step "3 · mcp";     run neon mcp -y
  step "4 · link";    run neon link --project-id little-bar-59488295 --branch production -y
  step "5 · config";  run neon config init

  cat > neon.ts <<'TS'
import { defineConfig } from "@neon/config/v1";

export default defineConfig({});
TS
  echo "neon.ts written"

  step "6 · deploy"; run neon deploy

  step "7 · master connection string → .env.local"
  MASTER_URL="$(neon connection-string production --project-id little-bar-59488295 2>/dev/null | tail -1)"
  if [[ -z "${MASTER_URL}" || "${MASTER_URL}" != postgres* ]]; then
    echo "❌ could not read the master connection string"; return 1
  fi
  if [[ ! -f .env.local ]]; then
    cp .env.example .env.local
    ENC_KEY="$(openssl rand -hex 32)"
    AUTH_SECRET="$(openssl rand -base64 32)"
    /usr/bin/sed -i '' \
      -e "s#^INFRA_MASTER_DATABASE_URL=.*#INFRA_MASTER_DATABASE_URL=\"${MASTER_URL}\"#" \
      -e "s#^INFRA_MASTER_ENCRYPTION_KEY=.*#INFRA_MASTER_ENCRYPTION_KEY=\"${ENC_KEY}\"#" \
      -e "s#^BETTER_AUTH_SECRET=.*#BETTER_AUTH_SECRET=\"${AUTH_SECRET}\"#" \
      .env.local 2>/dev/null || python3 - "$MASTER_URL" "$ENC_KEY" "$AUTH_SECRET" <<'PY'
import sys, re, pathlib
url, enc, auth = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path('.env.local'); s = p.read_text()
s = re.sub(r'^INFRA_MASTER_DATABASE_URL=.*$', f'INFRA_MASTER_DATABASE_URL="{url}"', s, flags=re.M)
s = re.sub(r'^INFRA_MASTER_ENCRYPTION_KEY=.*$', f'INFRA_MASTER_ENCRYPTION_KEY="{enc}"', s, flags=re.M)
s = re.sub(r'^BETTER_AUTH_SECRET=.*$', f'BETTER_AUTH_SECRET="{auth}"', s, flags=re.M)
p.write_text(s)
PY
    # Printed straight to the terminal so it never reaches the log Claude reads.
    {
      echo ""
      echo "┌──────────────────────────────────────────────────────────────┐"
      echo "│  SAO LƯU KHOÁ NÀY VÀO PASSWORD MANAGER — CHỈ HIỆN MỘT LẦN    │"
      echo "│  Mất khoá = mất toàn bộ connection string đã mã hoá          │"
      echo "└──────────────────────────────────────────────────────────────┘"
      echo "INFRA_MASTER_ENCRYPTION_KEY=${ENC_KEY}"
      echo ""
    } > /dev/tty 2>/dev/null || true
    echo "(encryption key printed on your terminal only — save it now)"
  else
    echo ".env.local already exists — left untouched"
  fi

  step "8 · install (macOS binaries)"; run pnpm install

  step "9 · migrate the master db"; run pnpm db:migrate

  step "10 · second neon project → SMOKE_NEON_URL"
  SECOND_ID="$(neon projects list --output json 2>/dev/null \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);ps=d.get("projects",d) if isinstance(d,dict) else d;print(next((p["id"] for p in ps if p["id"]!="little-bar-59488295"),""))' 2>/dev/null)"
  if [[ -n "${SECOND_ID}" ]]; then
    echo "second project found"
    SMOKE_URL="$(neon connection-string --project-id "${SECOND_ID}" 2>/dev/null | tail -1)"
    if [[ "${SMOKE_URL}" == postgres* ]]; then
      python3 - "$SMOKE_URL" <<'PY'
import sys, re, pathlib
url = sys.argv[1]
p = pathlib.Path('.secrets/tenants.env'); s = p.read_text()
s = re.sub(r'^SMOKE_NEON_URL=.*$', f'SMOKE_NEON_URL="{url}"', s, flags=re.M)
p.write_text(s)
PY
      echo "SMOKE_NEON_URL written"
    fi
  else
    echo "no second project found — smoke test will run with supabase only"
  fi

  step "11 · multi-provider smoke test"; run pnpm smoke

  step "done"
}

main 2>&1 | redact | tee "${LOG}"
echo ""
echo "Log (đã che secret): ${LOG}"
