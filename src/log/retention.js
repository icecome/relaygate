'use strict';
/**
 * log/retention.js — logs/ 日期目录保留策略（m-29）。
 *
 * traffic.jsonl / audit.jsonl 按日落在 logs/YYYY-MM-DD/ 下，此前无清理策略，
 * 长期运行目录数无限增长。本模块在服务启动时按保留天数清理过期日期目录。
 * 与 backup.js 的 pruneBackups 同口径：清理失败只告警，不阻断启动。
 */
const fs = require('fs');
const path = require('path');

/** 保留天数：LOG_RETENTION_DAYS（默认 30，0 = 不清理）。 */
function retentionDays() {
  const n = Number(process.env.LOG_RETENTION_DAYS);
  if (!Number.isFinite(n) || n < 0) return 30;
  return Math.floor(n);
}

/** YYYY-MM-DD 目录名 → 距今天数；非法名返回 null（不清理未知目录）。 */
function ageInDays(name, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(name));
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86400_000);
}

/**
 * 清理 logs/ 下超过保留期的日期目录。
 * @param {string} logsDir logs 目录绝对路径
 * @returns {{removed: string[], errors: number}}
 */
function pruneLogDirs(logsDir, now = new Date()) {
  const removed = [];
  let errors = 0;
  const keep = retentionDays();
  if (keep <= 0) return { removed, errors };
  let entries;
  try {
    entries = fs.readdirSync(logsDir, { withFileTypes: true });
  } catch {
    return { removed, errors }; // logs 目录不存在等，视为无可清理
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const age = ageInDays(ent.name, now);
    if (age == null || age < keep) continue;
    try {
      fs.rmSync(path.join(logsDir, ent.name), { recursive: true, force: true });
      removed.push(ent.name);
    } catch {
      errors += 1;
    }
  }
  return { removed, errors };
}

/** 启动期入口：失败只打日志，绝不抛出（不影响服务启动）。 */
function pruneAtStartup(rootDir) {
  try {
    const logsDir = path.join(rootDir, 'logs');
    const r = pruneLogDirs(logsDir);
    if (r.removed.length) {
      console.log(`[log-retention] pruned ${r.removed.length} expired log dirs (keep ${retentionDays()}d): ${r.removed.join(', ')}`);
    }
    if (r.errors) console.warn(`[log-retention] ${r.errors} dirs failed to remove`);
  } catch (e) {
    console.warn(`[log-retention] prune failed: ${e.message}`);
  }
}

module.exports = { retentionDays, ageInDays, pruneLogDirs, pruneAtStartup };
