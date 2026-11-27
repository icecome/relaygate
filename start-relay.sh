#!/usr/bin/env sh
# RelayGate — 纯转发模式启动脚本（Linux/macOS）
# 只跑 HTTP 转发面 + 账号池选号；不注册任何后台定时任务
# （签到 / token 临期扫描 / 保活 / 余额刷新 / 备份 / 成长 / ZCode / Qoder /
#  Raccoon 奖励 / 账号轮换 / 客户端凭据同步）。
# Requires: Node >= 22.5 (built-in node:sqlite)

cd "$(dirname "$0")" || exit 1

# 解析 node：sudo 会重置 PATH（secure_path），shell 里能用的 node 在 root 下常常找不到。
# 优先级：NODE_BIN 显式指定 > PATH > 常见安装位置。
NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  NODE=$(command -v node 2>/dev/null || true)
fi
if [ -z "$NODE" ]; then
  for c in \
    "$HOME/.nvm/versions/node/"*/bin/node \
    "$HOME/.local/share/fnm/node-versions/"*/installation/bin/node \
    /usr/local/bin/node /usr/bin/node /opt/node/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "[relaygate] 找不到 node。请先在普通用户下查路径：which node" >&2
  echo "[relaygate] 然后显式传入：sudo env NODE_BIN=\$(which node) ./start-relay.sh" >&2
  exit 1
fi
echo "[relaygate] node=$NODE ($("$NODE" -v 2>/dev/null || echo 'version unknown'))"

# 首次运行装依赖；npm 用与 node 同目录的那个，避免 sudo 下再次找不到。
if [ ! -d "node_modules/express" ]; then
  NPM="$(dirname "$NODE")/npm"
  [ -x "$NPM" ] || NPM="npm"
  "$NPM" install || exit 1
fi

if [ -f .env ]; then
  echo "[relaygate] using .env"
fi

# 总闸：src/index.js 在注册点据此跳过全部后台 job。
# 注意各 job 自己的 *_ENABLED 开关会被 .trae-api/*-settings.json 覆盖，不能用。
export RELAY_ONLY=true

echo "[relaygate] relay-only mode: background jobs disabled"
echo "[relaygate] starting on http://localhost:${PORT:-19900}"
exec "$NODE" src/index.js
