#!/usr/bin/env bash
# Phase 2 — everything after the neon CLI steps have already succeeded.
#   bash scripts/finish-setup.sh
# Fills in .env.local, migrates the master database, runs the multi-provider smoke test.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p logs
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="logs/finish-${STAMP}.log"
RAW="logs/.raw-${STAMP}"

redact() {
  sed -E \
    -e 's#(postgres(ql)?://)[^[:space:]"]*#\1<REDACTED-DSN>#g' \
    -e 's#(libsql://)[^[:space:]"]*#\1<REDACTED-DSN>#g' \
    -e 's#napi_[A-Za-z0-9_-]+#<REDACTED-API-KEY>#g' \
    -e 's#(authToken=)[A-Za-z0-9._-]+#\1<REDACTED>#g' \
    -e 's#(pk_(live|test)_)[0-9A-Za-z]+#\1<REDACTED>#g' \
    -e 's#[0-9a-f]{64}#<REDACTED-HEX>#g'
}
cleanup() { [[ -f "${RAW}" ]] && { redact < "${RAW}" > "${LOG}"; rm -f "${RAW}"; }; }
trap cleanup EXIT INT TERM

step() { echo ""; echo "═══ $* ═══"; }
run()  { echo "\$ $*"; "$@" 2>&1; local rc=$?; echo "  ↳ exit=${rc}"; return ${rc}; }

main() {
  step "A · fill in .env.local"
  run python3 scripts/ensure-env.py || return 1

  step "B · migrate the master database"
  if ! run pnpm db:migrate; then
    echo "hint: if this says 'url' is empty, .env.local has no database url yet"
    return 1
  fi

  step "C · verify the 9 tables exist"
  run pnpm --filter @infra/db exec tsx scripts/verify-schema.mts

  step "D · multi-provider smoke test"
  run pnpm smoke

  step "done"
}

main 2>&1 | tee "${RAW}"
cleanup
echo ""
echo "Log (đã che secret): ${LOG}"
