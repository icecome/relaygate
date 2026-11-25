'use strict';
/**
 * session/sticky.js — 会话粘性：同一 stickyKey 尽量绑定同一 accountId。
 * 内存 TTL 表，重启丢失可接受（个人网关）。
 */
const TTL_MS = 60 * 60 * 1000; // 1 小时
const MAX_ENTRIES = 10000; // 容量上限（M-02）：防止可控 sticky-key 无限注入撑爆内存
const MAX_KEY_LEN = 128; // 超过该长度先哈希，避免超长字符串明文驻留

/** 把外部输入的 sticky key 归一为有界长度；长 key / 敏感会话 id 走 sha256。 */
function normalizeKey(value) {
  const s = String(value);
  if (s.length <= MAX_KEY_LEN) return s;
  return require('crypto').createHash('sha256').update(s).digest('hex');
}

/** key -> { accountId, ts } */
const map = new Map();

/** 超容量时淘汰最旧 entry（Map 保持插入序，删第一个即最旧）。 */
function evictIfNeeded() {
  while (map.size >= MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function prune() {
  const now = Date.now();
  for (const [k, v] of map) {
    if (now - v.ts > TTL_MS) map.delete(k);
  }
}

function bind(stickyKey, accountId) {
  if (!stickyKey || !accountId) return;
  prune();
  evictIfNeeded();
  map.set(normalizeKey(stickyKey), { accountId: String(accountId), ts: Date.now() });
}

/**
 * 仅在**未绑定**时写入（首次绑定）。
 *
 * 用途：权益让位后重新选号时，不能覆盖调用方原有的绑定——那会把
 * 「这个会话本该用谁」的既有事实抹掉（让位是临时决策，不该改长期绑定）。
 * @returns {boolean} 是否实际写入
 */
function bindIfAbsent(stickyKey, accountId) {
  if (!stickyKey || !accountId) return false;
  prune();
  evictIfNeeded();
  const k = normalizeKey(stickyKey);
  if (map.has(k)) return false;
  map.set(k, { accountId: String(accountId), ts: Date.now() });
  return true;
}

function lookup(stickyKey) {
  if (!stickyKey) return null;
  prune();
  const hit = map.get(normalizeKey(stickyKey));
  if (!hit) return null;
  hit.ts = Date.now(); // 命中即刷新 TTL 起点
  return hit.accountId;
}

function unbind(stickyKey) {
  if (stickyKey) map.delete(normalizeKey(stickyKey));
}

/**
 * 从 OpenAI/Anthropic 请求推导 sticky key。
 * 优先取 user 侧自定义头（扩展），否则取 messages 内的稳定 hash 线索。
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

module.exports = { bind, bindIfAbsent, lookup, unbind, stickyKeyFromRequest, size, listSafe, TTL_MS, MAX_ENTRIES };
