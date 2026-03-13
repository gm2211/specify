#!/bin/bash
export FORCE_COLOR=1
cd /Users/gmecocci/projects/specify
CLI="./specify"

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
type_cmd "specify spec lint --spec app.spec.yaml"
$CLI spec lint --spec specify.spec.yaml 2>&1 1>/dev/null
sleep 1
echo
type_cmd "specify cli run --spec app.spec.yaml"
printf '\033[2mRunning 24 commands...\033[0m\n'
sleep 0.8
# Only show the summary line
$CLI cli run --spec specify.spec.yaml 2>&1 1>/dev/null | tail -1
sleep 1.5
