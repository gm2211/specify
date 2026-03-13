#!/bin/bash
# Scripted demo for asciinema recording

type_cmd() {
  local cmd="$1"
  # Simulate typing
  for (( i=0; i<${#cmd}; i++ )); do
    printf '%s' "${cmd:$i:1}"
    sleep 0.04
  done
  echo
  sleep 0.3
}

green='\033[1;32m'
yellow='\033[1;33m'
blue='\033[1;34m'
dim='\033[2m'
reset='\033[0m'
bold='\033[1m'

clear
echo -e "${dim}# Lint a spec for structural errors${reset}"
sleep 0.5
printf '❯ '
type_cmd "specify spec lint --spec specify.spec.yaml"
node /Users/gmecocci/projects/specify/dist/src/cli/index.js spec lint --spec /Users/gmecocci/projects/specify/specify.spec.yaml 2>&1
sleep 1.5

echo
echo -e "${dim}# Export spec as Playwright tests${reset}"
sleep 0.5
printf '❯ '
type_cmd "specify spec export --spec login-page.yaml --framework playwright --json | head -20"
node /Users/gmecocci/projects/specify/dist/src/cli/index.js spec export --spec /Users/gmecocci/projects/specify/src/spec/examples/login-page.yaml --framework playwright --json 2>/dev/null | head -20
sleep 1.5

echo
echo -e "${dim}# Evolve: find gaps in a spec${reset}"
sleep 0.5
printf '❯ '
type_cmd "specify spec evolve --spec login-page.yaml --json | jq '.suggestions[:2]'"
node /Users/gmecocci/projects/specify/dist/src/cli/index.js spec evolve --spec /Users/gmecocci/projects/specify/src/spec/examples/login-page.yaml --json 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
s = d.get('suggestions', [])[:2]
print(json.dumps(s, indent=2))
"
sleep 1.5

echo
echo -e "${dim}# Run CLI validation against self-spec${reset}"
sleep 0.5
printf '❯ '
type_cmd "specify cli run --spec specify.spec.yaml 2>&1 | tail -8"
cd /Users/gmecocci/projects/specify && node dist/src/cli/index.js cli run --spec specify.spec.yaml 2>&1 | tail -8
sleep 2
