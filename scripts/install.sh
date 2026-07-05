#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."
npm install -g .
# Run the installer via the local entrypoint so it works even when the global
# npm bin directory is not yet on PATH in this shell.
node ./bin/claude-cache-guard.js install "$@"
