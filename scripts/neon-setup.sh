#!/usr/bin/env bash
# Runs the Neon project setup end to end using the API key in .secrets/neon.env.
# Nothing here prints the key or any connection string.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .secrets/neon.env ]]; then
  echo "❌ .secrets/neon.env not found — copy .secrets/neon.env.example and paste your API key."
  exit 1
fi

set -a; source .secrets/neon.env; set +a
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"

PROJECT_ID="${NEON_PROJECT_ID:-little-bar-59488295}"
BRANCH="${NEON_BRANCH:-production}"

echo "→ whoami"
neon me

echo "→ skills"
neon skills -y

echo "→ mcp"
neon mcp -y

echo "→ link project ${PROJECT_ID} (branch ${BRANCH})"
neon link --project-id "${PROJECT_ID}" --branch "${BRANCH}" -y

echo "→ config init"
neon config init

cat > neon.ts <<'TS'
import { defineConfig } from "@neon/config/v1";

export default defineConfig({});
TS
echo "→ neon.ts written"

echo "→ deploy"
neon deploy

echo "✅ done"
