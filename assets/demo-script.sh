#!/bin/bash
# Scripted demo — compact
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

# 1. Lint
type_cmd "specify spec lint --spec app.spec.yaml"
$CLI spec lint --spec specify.spec.yaml 2>&1 1>/dev/null
sleep 1.2

# 2. CLI validation summary
echo
type_cmd "specify cli run --spec app.spec.yaml"
$CLI cli run --spec specify.spec.yaml 2>&1 1>/dev/null
sleep 1.5
