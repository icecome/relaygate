'use strict';
/**
 * 迁移：旧项目 my-trae-api → 新项目 RelayGate
 *
 * 策略（用户确认）：
 *   - 新增缺失：旧项目独有的 10 个账号（5 cn + 5 workbuddy）全量导入，
 *     含 token 密文、余额、签到记录、积分快照、设备指纹。
 *   - 保留新项目现有：6 个共有账号不动（两边配置 100% 一致，
 *     保留新项目更新的签到/冷却/余额状态）。
 *   - credit_history：仅迁移缺失账号的历史（避免与新项目已有记录重复）。
 *
 * 两项目 encrypt.key 相同（sha256 EE1BE53C…），token 密文可直接复制。
 *
 * 安全：迁移前备份新项目 DB；全程只读旧库。
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || './output';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// 旧库路径：优先 OLD_TRAE_DB 环境变量，缺省按「与当前项目同级的 my-trae-api」推导
const OLD_DB = process.env.OLD_TRAE_DB
  || path.resolve('..', 'my-trae-api', 'output/.trae-api/trae-relay.db');
const NEW_DB = path.resolve('output/.trae-api/trae-relay.db');
const BACKUP_DIR = path.resolve('backups');

function main() {
  if (!fs.existsSync(OLD_DB)) throw new Error('旧库不存在: ' + OLD_DB);
  if (!fs.existsSync(NEW_DB)) throw new Error('新库不存在: ' + NEW_DB);

  // 1) 备份新库
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUP_DIR, `trae-relay-before-migrate-${stamp}.db`);
  fs.copyFileSync(NEW_DB, backup);
  console.log('[migrate] 新库已备份 →', backup);

  const old = new DatabaseSync(OLD_DB, { readOnly: true });
  const neu = new DatabaseSync(NEW_DB);
  // 服务进程可能正持有新库：默认 busy_timeout=0 会直接 SQLITE_BUSY，给 15s 重试窗口
  neu.exec('PRAGMA busy_timeout = 15000');

  const keyOf = (r) => `${r.edition}|${r.user_id || r.label}`;
  const oldRows = old.prepare('SELECT * FROM accounts').all();
  const newRows = neu.prepare('SELECT * FROM accounts').all();
  const existing = new Set(newRows.map(keyOf));

  const toInsert = oldRows.filter((r) => !existing.has(keyOf(r)));
  console.log(`[migrate] 旧库 ${oldRows.length} 个，新库 ${newRows.length} 个，待迁移 ${toInsert.length} 个`);

  if (!toInsert.length) {
    console.log('[migrate] 无缺失账号，跳过');
    return;
  }

  // 2) 按新库列顺序插入（两库表结构完全一致，28 列）
  const cols = neu.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
  const placeholders = cols.map(() => '?').join(', ');
  const insertSql = `INSERT INTO accounts (${cols.join(', ')}) VALUES (${placeholders})`;
  const insert = neu.prepare(insertSql);

  neu.exec('BEGIN');
  let inserted = 0;
  const insertedIds = [];
  try {
    for (const row of toInsert) {
      insert.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
      inserted++;
      insertedIds.push(row.id);
      console.log(`  + [${row.edition}] ${row.label}  uid=${String(row.user_id).slice(0, 8)}  balance=${row.balance}  enabled=${row.enabled}`);
    }

    // 3) 迁移这些账号的 credit_history（避免与已有记录重复）
    const oldCh = old.prepare('SELECT account_id, ts, remaining, used_total, source FROM credit_history WHERE account_id = ? ORDER BY ts');
    let chCount = 0;
    const insCh = neu.prepare('INSERT INTO credit_history (account_id, ts, remaining, used_total, source) VALUES (?, ?, ?, ?, ?)');
    for (const id of insertedIds) {
      const rows = oldCh.all(id);
      for (const r of rows) {
        insCh.run(r.account_id, r.ts, r.remaining, r.used_total, r.source);
        chCount++;
      }
    }
    console.log(`[migrate] credit_history 迁移 ${chCount} 条`);

    neu.exec('COMMIT');
    console.log(`[migrate] 提交完成：新增账号 ${inserted} 个，积分历史 ${chCount} 条`);
  } catch (e) {
    neu.exec('ROLLBACK');
    console.error('[migrate] 失败已回滚:', e.message);
    console.error('[migrate] 新库备份仍在:', backup);
    throw e;
  }

  // 4) 终态核对
  const after = neu.prepare('SELECT edition, count(*) c FROM accounts GROUP BY edition').all();
  console.log('[migrate] 迁移后新库账号分布:', JSON.stringify(after));
  const total = neu.prepare('SELECT count(*) c FROM accounts').get();
  console.log('[migrate] 新库账号总数 =', total.c);
}

main();
