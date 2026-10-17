#!/bin/sh
set -eu

# Resolve the checkout without depending on the interactive shell or Node PATH.
prism_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
prism_electron="$prism_root/node_modules/electron/dist/electron"

if [ ! -x "$prism_electron" ] || [ ! -f "$prism_root/dist/main.cjs" ]; then
  printf '%s\n' 'Prism needs installation. Run npm ci and npm run install:markdown in the Prism repository.' >&2
  exit 1
fi

cd "$prism_root"
exec "$prism_electron" "$prism_root" "$@"
