#!/usr/bin/env bash
# Runs every step that needs real network access to Neon / Supabase / Turso.
# Must be run from the user's own Terminal — the Claude sandbox cannot reach those hosts.
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
PROJECT_ID="little-bar-59488295"

redact() {
  sed -E \
    -e 's#(postgres(ql)?://)[^[:space:]"]*#\1<REDACTED-DSN>#g' \
    -e 's#(libsql://)[^[:space:]"]*#\1<REDACTED-DSN>#g' \
    -e 's#napi_[A-Za-z0-9_-]+#<REDACTED-API-KEY>#g' \
    -e 's#(authToken=)[A-Za-z0-9._-]+#\1<REDACTED>#g' \
    -e 's#(pk_(live|test)_)[0-9A-Za-z]+#\1<REDACTED>#g' \
    -e 's#(INFRA_MASTER_ENCRYPTION_KEY=)[^[:space:]"]*#\1<REDACTED>#g' \
    -e 's#(BETTER_AUTH_SECRET=)[^[:space:]"]*#\1<REDACTED>#g' \
    -e 's#[0-9a-f]{64}#<REDACTED-HEX>#g'
}

step() { echo ""; echo "═══ $* ═══"; }
run()  { echo "\$ $*"; "$@" 2>&1; local rc=$?; echo "  ↳ exit=${rc}"; return ${rc}; }

# Same as run(), but kills anything that sits waiting for input.
runt() {
  local limit="$1"; shift
  echo "\$ $* (timeout ${limit}s)"
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "${limit}" "$@" 2>&1
  else
    "$@" 2>&1 &
    local pid=$!
    ( sleep "${limit}"; kill -9 ${pid} 2>/dev/null ) & local watcher=$!
    wait ${pid} 2>/dev/null
    kill ${watcher} 2>/dev/null
  fi
  local rc=$?
  echo "  ↳ exit=${rc}"
  return ${rc}
}

NEON=()

setup_neon_cli() {
  export PATH="$HOME/.npm-global/bin:$PATH"

  if command -v neon >/dev/null 2>&1; then NEON=(neon); return 0; fi

  echo "installing the neon CLI into your home directory (no sudo needed)…"
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global" >/dev/null 2>&1
  if npm i -g neon@latest >/dev/null 2>&1; then
    export PATH="$HOME/.npm-global/bin:$PATH"
    if command -v neon >/dev/null 2>&1; then NEON=(neon); echo "installed: $(neon --version)"; return 0; fi
  fi

  echo "global install unavailable — falling back to npx (slower first run, same result)"
  if npx -y neon@latest --version >/dev/null 2>&1; then
    NEON=(npx -y neon@latest)
    echo "using: npx neon@latest"
    return 0
  fi

  echo "❌ could not obtain the neon CLI"
  return 1
}

main() {
  step "0 · toolchain"
  echo "node: $(node -v 2>&1)"
  echo "npm:  $(npm -v 2>&1)"
  command -v corepack >/dev/null && corepack enable >/dev/null 2>&1
  command -v pnpm >/dev/null || corepack prepare pnpm@9.12.0 --activate >/dev/null 2>&1
  echo "pnpm: $(pnpm -v 2>&1)"

  [[ -f .secrets/neon.env ]] || { echo "❌ .secrets/neon.env missing"; return 1; }
  set -a; source .secrets/neon.env; set +a
  [[ -f .secrets/tenants.env ]] && { set -a; source .secrets/tenants.env; set +a; }

  setup_neon_cli || return 1

  step "1 · who am I"
  runt 60 "${NEON[@]}" me || { echo "❌ the API key was rejected — create a new one in Account settings → API keys"; return 1; }

  step "2 · skills";  runt 120 "${NEON[@]}" skills -y
  step "3 · mcp";     runt 120 "${NEON[@]}" mcp -y
  step "4 · link";    runt 120 "${NEON[@]}" link --project-id "${PROJECT_ID}" --branch production -y
  step "5 · config";  runt 180 "${NEON[@]}" config init

  cat > neon.ts <<'TS'
import { defineConfig } from "@neon/config/v1";

export default defineConfig({});
TS
  echo "neon.ts written"

  step "6 · deploy"; runt 300 "${NEON[@]}" deploy

  step "7 · fill in .env.local"
  # `neon link` already wrote DATABASE_URL here; this only adds what is still missing.
  run python3 scripts/ensure-env.py || return 1

  step "8 · install (macOS binaries)"; run pnpm install

  step "9 · migrate the master db"; run pnpm db:migrate

  step "10 · second neon project → SMOKE_NEON_URL"
  SECOND_ID="$("${NEON[@]}" projects list --output json 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
ps = d.get("projects", d) if isinstance(d, dict) else d
print(next((p["id"] for p in ps if p.get("id") != "little-bar-59488295"), ""))
' 2>/dev/null)"
  if [[ -n "${SECOND_ID}" ]]; then
    echo "second project found"
    SMOKE_URL="$("${NEON[@]}" connection-string --project-id "${SECOND_ID}" 2>/dev/null | grep -o 'postgres[^[:space:]]*' | tail -1)"
    if [[ -n "${SMOKE_URL}" ]]; then
      python3 - "$SMOKE_URL" <<'PY'
import sys, re, pathlib
url = sys.argv[1]
p = pathlib.Path('.secrets/tenants.env'); s = p.read_text()
s = re.sub(r'^SMOKE_NEON_URL=.*$', f'SMOKE_NEON_URL="{url}"', s, flags=re.M)
p.write_text(s)
print("SMOKE_NEON_URL written")
PY
    fi
  else
    echo "no second project found — the smoke test will run with supabase only"
  fi

  step "11 · multi-provider smoke test"; run pnpm smoke

  step "done"
}

RAW="logs/.raw-${STAMP}"
cleanup() { [[ -f "${RAW}" ]] && { redact < "${RAW}" > "${LOG}"; rm -f "${RAW}"; }; }
trap cleanup EXIT INT TERM

main 2>&1 | tee "${RAW}"
cleanup
echo ""
echo "Log (đã che secret): ${LOG}"
