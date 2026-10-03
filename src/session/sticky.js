'use strict';
/**
 * session/sticky.js — 会话粘性：同一 stickyKey 尽量绑定同一 accountId。
 * 内存 TTL 表，重启丢失可接受（个人网关）。
 */
const TTL_MS = 60 * 60 * 1000; // 1h

/** key -> { accountId, ts } */
const map = new Map();

function prune() {
  const now = Date.now();
  for (const [k, v] of map) {
    if (now - v.ts > TTL_MS) map.delete(k);
  }
}

function bind(stickyKey, accountId) {
  if (!stickyKey || !accountId) return;
  prune();
  map.set(String(stickyKey), { accountId: String(accountId), ts: Date.now() });
}

function lookup(stickyKey) {
  if (!stickyKey) return null;
  prune();
  const hit = map.get(String(stickyKey));
  if (!hit) return null;
  hit.ts = Date.now(); // TTL 滚动
  return hit.accountId;
}

function unbind(stickyKey) {
  if (stickyKey) map.delete(String(stickyKey));
}

/**
 * 从 OpenAI/Anthropic 请求推导 sticky key。
 * 优先 user 侧自定义头（扩展），否则取 messages 内稳定 hash 线索。
 */
function stickyKeyFromRequest(req) {
  const h = req.headers || {};
  const explicit = h['x-sticky-key'] || h['x-session-id'] || h['x-conversation-id'];
  if (explicit) return String(explicit);

  const body = req.body || {};
  const meta = body.user || body.metadata;
  if (meta && typeof meta === 'object') {
    if (meta.session_id) return String(meta.session_id);
    if (meta.conversation_id) return String(meta.conversation_id);
    if (meta.sticky_key) return String(meta.sticky_key);
  }

  // 无明确会话：不做粘性（避免误绑）
  return null;
}

function size() {
  return map.size;
}

/** 面板用：脱敏 sticky key，只保留末 6 位。 */
function listSafe() {
  prune();
  const now = Date.now();
  return Array.from(map.entries()).map(([k, v]) => ({
    keyTail: String(k).slice(-6),
    accountId: v.accountId,
    expiresAt: new Date(v.ts + TTL_MS).toISOString(),
    ttlSec: Math.max(0, Math.round((v.ts + TTL_MS - now) / 1000)),
  }));
}

module.exports = { bind, lookup, unbind, stickyKeyFromRequest, size, listSafe, TTL_MS };
