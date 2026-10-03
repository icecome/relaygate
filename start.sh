#!/usr/bin/env sh
# relay-gate startup script (Linux/macOS)
# Requires: Node >= 22.5 (built-in node:sqlite)
# Comments are ASCII on purpose: this file is UTF-8, but some terminals decode
# it as GBK on zh-CN Windows and show mojibake.
cd "$(dirname "$0")" || exit 1

# Install deps on first run (comment out if already installed)
[ -d "node_modules/express" ] || npm install

if [ -f .env ]; then
  echo "[relay-gate] using .env"
fi

echo "[relay-gate] starting on http://localhost:${PORT:-19900}"
node src/index.js
