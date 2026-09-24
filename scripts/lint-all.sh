#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

status=0

run_lint() {
  local label="$1"
  shift

  printf '==> %s\n' "$label"
  "$@"
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    status=$rc
  fi
}

# lint-drift:v1:begin language=JavaScript
run_lint "ESLint JavaScript" npx eslint --config eslint.config.js --max-warnings 0 '**/*.{js,mjs,cjs}'
# lint-drift:v1:end language=JavaScript

# lint-drift:v1:begin language=TypeScript
run_lint "ESLint TypeScript" npx eslint --config eslint.config.js --max-warnings 0 '**/*.{ts,tsx}'
# lint-drift:v1:end language=TypeScript

exit "$status"
