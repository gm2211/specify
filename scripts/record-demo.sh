#!/usr/bin/env bash
# Record real CLI output in a disposable project, then render the README GIF.
set -euo pipefail
demo_root="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${1:-}" != --session ]]; then
  cd "$demo_root"
  command -v asciinema >/dev/null
  command -v agg >/dev/null
  npm run build
  asciinema rec --headless --return --overwrite --output-format asciicast-v2 \
    --window-size 104x20 --title 'Specify: intent to readable contracts' \
    --capture-env '' --command 'bash scripts/record-demo.sh --session' docs/media/demo.cast
  agg --theme github-dark --font-family Menlo --font-size 15 --fps-cap 12 \
    --idle-time-limit 8 --last-frame-duration 4 docs/media/demo.cast docs/media/demo.gif
  exit
fi

demo_work="$(mktemp -d /tmp/specify-demo.XXXXXX)"
demo_pid=''
cleanup() {
  if [[ -n "$demo_pid" ]]; then
    kill "$demo_pid" 2>/dev/null || true
    wait "$demo_pid" 2>/dev/null || true
  fi
  rm -rf "$demo_work"
  printf '\033[?25h'
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp -R "$demo_root/specify.spec" "$demo_work/specify.spec"
cd "$demo_work"
specify() { node "$demo_root/dist/src/cli/index.js" "$@"; }
scene() {
  printf '\033[2J\033[H\033[?25l\033[1;36mSPECIFY\033[0m  %s\n\n' "$1"
}
run() {
  printf '\033[1;32m$\033[0m %s\n' "$*"
  sleep 0.7
  "$@"
}

scene 'Keep intent readable, with precise contracts underneath.'
run sed -n 8,15p specify.spec/areas/overview.yaml
sleep 7

scene 'Give agents the same capture / review / reconcile workflow.'
run specify spec init --spec specify.spec
sleep 5

scene 'Check structure. Project tests still check application behavior.'
run specify spec lint --spec specify.spec
sleep 5

scene 'Open the bundled reader in any project.'
printf '\033[1;32m$\033[0m specify view --no-open\n'
sleep 0.7
node "$demo_root/dist/src/cli/index.js" view --no-open &
demo_pid=$!
sleep 5
kill -0 "$demo_pid"
kill -TERM "$demo_pid"
wait "$demo_pid"
demo_pid=''
printf '\nViewer stopped. Your spec stays in Git.\n'
sleep 3
