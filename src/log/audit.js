'use strict';
/**
 * log/audit.js — 安全审计日志（append-only）。
 * 写入 SQLite audit_log + 可选 JSONL；主路径应不阻塞（同步小写可接受）。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

function table() {
  try {
    return require('../credentials/db').db();
  } catch {
    return null;
  }
}

function jsonlFile() {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(config.workspaceDir || process.cwd(), 'logs', day);
  return path.join(dir, 'audit.jsonl');
}

/**
 * @param {{action:string, actorKeyId?:string|null, resource?:string|null,
 *          result:'allow'|'deny'|'error'|'ok', reason?:string|null,
 *          requestId?:string|null, clientIp?:string|null, userAgent?:string|null,
 *          meta?:object|null}} ev
 */
function audit(ev) {
  const row = {
    ts: new Date().toISOString(),
    request_id: ev.requestId || null,
    action: String(ev.action || 'unknown'),
    actor_key_id: ev.actorKeyId || null,
    resource: ev.resource || null,
    result: String(ev.result || 'error'),
    reason: ev.reason || null,
    client_ip: ev.clientIp || null,
    user_agent: ev.userAgent ? String(ev.userAgent).slice(0, 200) : null,
    meta: ev.meta ? JSON.stringify(ev.meta).slice(0, 2000) : null,
  };
  try {
    const db = table();
    if (db) {
      db.prepare(
        `INSERT INTO audit_log (ts, request_id, action, actor_key_id, resource, result, reason, client_ip, user_agent, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.ts, row.request_id, row.action, row.actor_key_id, row.resource, row.result, row.reason, row.client_ip, row.user_agent, row.meta);
    }
  } catch (e) {
    console.error('[audit] db write failed:', e.message);
  }
  try {
    const f = jsonlFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(row) + '\n', 'utf-8');
  } catch { /* jsonl best-effort */ }
  return row;
}

function query({ action = null, actorKeyId = null, result = null, limit = 100 } = {}) {
  const db = table();
  if (!db) return [];
  const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const args = [];
  if (action) { sql += ' AND action = ?'; args.push(action); }
  if (actorKeyId) { sql += ' AND actor_key_id = ?'; args.push(actorKeyId); }
  if (result) { sql += ' AND result = ?'; args.push(result); }
  sql += ' ORDER BY id DESC LIMIT ?';
  args.push(n);
  return db.prepare(sql).all(...args);
}

module.exports = { audit, query, jsonlFile };
