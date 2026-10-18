#!/usr/bin/env bash
# Run inside an isolated Xvfb display. Native maximize/restore needs a window manager.
set -euo pipefail

openbox --sm-disable &
prism_wm_pid=$!
trap 'kill "$prism_wm_pid" 2>/dev/null || true; wait "$prism_wm_pid" 2>/dev/null || true' EXIT

prism_wm_ready=false
for ((attempt = 0; attempt < 100; attempt++)); do
  if [[ $(xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null) == *"window id # 0x"* ]]; then
    prism_wm_ready=true
    break
  fi
  if ! kill -0 "$prism_wm_pid" 2>/dev/null; then
    echo 'The test window manager exited before becoming ready.' >&2
    exit 1
  fi
  sleep 0.05
done
if [[ $prism_wm_ready != true ]]; then
  echo 'The test window manager did not become ready.' >&2
  exit 1
fi

npm run test:e2e
