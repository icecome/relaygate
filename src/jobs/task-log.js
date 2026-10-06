'use strict';
/**
 * jobs/task-log.js — 定时任务执行日志（追加式 JSONL，环形保留最近 N 条/每任务）。
 *
 * 供面板「任务日志」查询：每次定时/手动任务执行写一行，含任务名、触发方式、结果汇总。
 * 文件：.trae-api/task-log.jsonl；上限 MAX_ENTRIES（默认 500），超出后截断（保留最近）。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../lib/atomic-write');
const { stateFile, resolveStateFileForRead } = require('../lib/paths');

/** 文件路径：支持 TASK_LOG_FILE 环境变量覆盖（默认 <workspaceDir>/.trae-api/task-log.jsonl）。 */
const FILE = () => process.env.TASK_LOG_FILE
  ? path.resolve(process.env.TASK_LOG_FILE)
  : stateFile('task-log.jsonl');
const MAX_ENTRIES = Number(process.env.TASK_LOG_MAX_ENTRIES) || 500;

// 进程内行数计数器（m-31 根因修复）：此前按「文件字节 > MAX_ENTRIES*512」粗估
// 触发整文件重写，阈值偏大且长日志行下周期性全量重写代价随文件线性增长。
// 现按真实行数精确计数，超限立即裁剪一次。
let lineCount = null;

/** 追加一条任务执行记录（best-effort，不抛错）。 */
function appendTaskLog(entry) {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    // 首次写入新位置时把旧位置的历史并过来，避免升级后「日志突然变空」
    migrateLegacyLog();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(FILE(), line, 'utf-8');
    // 首次写入时校准计数器（含迁移历史行）；此后增量维护
    if (lineCount == null) {
      lineCount = fs.readFileSync(FILE(), 'utf-8').split('\n').filter(Boolean).length;
    } else {
      lineCount += 1;
    }
    // 精确环形：按行数裁剪为最近 MAX_ENTRIES 条
    if (lineCount > MAX_ENTRIES) {
      const lines = fs.readFileSync(FILE(), 'utf-8').split('\n').filter(Boolean);
      if (lines.length > MAX_ENTRIES) {
        writeFileAtomic(FILE(), lines.slice(lines.length - MAX_ENTRIES).join('\n') + '\n');
        lineCount = MAX_ENTRIES;
      } else {
        lineCount = lines.length; // 计数漂移时校准
      }
    }
  } catch { /* 记录失败不影响主流程 */ }
}

/** 新位置尚无文件而旧位置有内容时，把旧日志复制到新位置（一次性迁移）。 */
function migrateLegacyLog() {
  try {
    // 显式指定路径时不做迁移：调用方已明确要求用这个文件
    if (process.env.TASK_LOG_FILE) return;
    // 仅在新位置为空时迁移；否则会把新日志覆盖回旧内容
    if (fs.existsSync(FILE())) return;
    const legacy = resolveStateFileForRead('task-log.jsonl', fs.existsSync);
    if (legacy === FILE() || !fs.existsSync(legacy)) return;
    const text = fs.readFileSync(legacy, 'utf-8');
    if (text.trim()) writeFileAtomic(FILE(), text);
  } catch { /* 迁移失败不阻塞写入 */ }
}

/**
 * 读取最近 N 条任务日志（新→旧）。
 *
 * 读取时若新位置不存在则回退旧位置（<ROOT>/.trae-api），保证从旧版本
 * 升级后历史日志仍可见；一旦有新写入，新位置即成为唯一来源。
 * @param {number} limit
 * @param {string} [task] 按任务名过滤
 */
function readTaskLog(limit = 100, task = null) {
  const rows = [];
  try {
    const f = fs.existsSync(FILE()) ? FILE() : resolveStateFileForRead('task-log.jsonl', fs.existsSync);
    if (!fs.existsSync(f)) return rows;
    const text = fs.readFileSync(f, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (task && r.task !== task) continue;
        rows.push(r);
      } catch { /* skip bad line */ }
    }
  } catch { /* 读取失败返回空 */ }
  rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return rows.slice(0, limit);
}

/** 清空任务日志（运维操作）。 */
function clearTaskLog() {
  try {
    return writeFileAtomic(FILE(), '');
  } catch {
    return false;
  }
}

module.exports = { appendTaskLog, readTaskLog, clearTaskLog, FILE };
