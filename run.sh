#!/usr/bin/env bash
# run.sh — Agent-friendly CLI for Specify
#
# Agent mode (default — structured JSON output):
#   ./run.sh                                        # JSON help with command manifest
#   ./run.sh schema commands                        # Full parameter schemas
#   ./run.sh spec validate --spec spec.yaml --capture ./captures/latest
#   ./run.sh spec validate --spec spec.yaml --capture ./captures/latest --fields summary
#   ./run.sh agent run --spec spec.yaml --url http://localhost:3000
#   ./run.sh report diff --a report1.json --b report2.json
#   cat spec.yaml | ./run.sh spec validate --spec - --capture ./captures/latest
#
# Human mode (interactive, with tab completion):
#   ./run.sh human                                  # Context-aware wizard
#   ./run.sh human shell --spec spec.yaml           # Interactive REPL
#   ./run.sh human watch --spec spec.yaml --url http://localhost:3000  # TUI dashboard

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$SCRIPT_DIR/dist/src/cli/index.js"

# Auto-build if dist is missing or any source file is newer
needs_build() {
  [ ! -f "$DIST" ] && return 0
  local newer
  newer=$(find "$SCRIPT_DIR/src" -name '*.ts' -newer "$DIST" -print -quit 2>/dev/null)
  [ -n "$newer" ]
}

if needs_build; then
  echo "Building TypeScript..." >&2
  npx tsc --project "$SCRIPT_DIR/tsconfig.json"
fi

exec node "$DIST" "$@"
