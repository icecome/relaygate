#!/usr/bin/env sh
# relay-gate 启动脚本（Linux/macOS）
# 依赖：Node >= 22.5（使用内置 node:sqlite）
cd "$(dirname "$0")" || exit 1

# 首次启动前安装依赖（如已安装可注掉）
[ -d "node_modules/express" ] || npm install

if [ -f .env ]; then
  echo "[relay-gate] using .env"
fi

echo "[relay-gate] starting on http://localhost:${PORT:-19900}"
node src/index.js
