#!/bin/bash
# Scripted demo for asciinema recording — compact and colorful
export FORCE_COLOR=1
CLI="node /Users/gmecocci/projects/specify/dist/src/cli/index.js"
cd /Users/gmecocci/projects/specify

type_cmd() {
  printf '\033[1;34m❯\033[0m '
  for (( i=0; i<${#1}; i++ )); do
    printf '%s' "${1:$i:1}"
    sleep 0.03
  done
  echo
  sleep 0.2
}

clear

# 1. Colored help (just commands section)
type_cmd "specify --help"
$CLI --help 2>&1 | head -22
sleep 1.5
echo

# 2. Lint — only show stderr (the colored verdict)
type_cmd "specify spec lint --spec specify.spec.yaml"
$CLI spec lint --spec specify.spec.yaml 2>&1 1>/dev/null
sleep 1
echo

# 3. CLI validation — show progress on stderr, suppress stdout
type_cmd "specify cli run --spec specify.spec.yaml"
$CLI cli run --spec specify.spec.yaml 2>&1 1>/dev/null
sleep 1.5
