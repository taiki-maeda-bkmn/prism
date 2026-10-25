#!/bin/sh
set -eu

# Resolve the checkout without depending on the interactive shell or Node PATH.
prism_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
prism_electron="$prism_root/node_modules/electron/dist/electron"

if [ ! -x "$prism_electron" ] || [ ! -f "$prism_root/dist/main.cjs" ]; then
  printf '%s\n' 'Prism needs installation. Run npm ci and npm run install:desktop in the Prism repository.' >&2
  exit 1
fi

cd "$prism_root"
# Use Electron's own Node runtime so the desktop shortcut needs no global Node
# executable. The shared wrapper chooses the backend before starting the GUI.
ELECTRON_RUN_AS_NODE=1 exec "$prism_electron" "$prism_root/scripts/start-markdown.mjs" "$@"
