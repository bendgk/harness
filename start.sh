#!/usr/bin/env bash
# Start Paper. Installs dependencies on first run (which also rebuilds node-pty against Electron), then launches
# the dev instance with hot reload. Pass --prod to build and run the production bundle instead.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found — install Node.js (https://nodejs.org) and try again." >&2
  exit 1
fi

# Reinstall when node_modules is missing or older than package.json.
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  echo "Installing dependencies…"
  npm install
  touch node_modules
fi

if [ "${1:-}" = "--prod" ]; then
  npm run build
  exec npm start
fi

exec npm run dev
