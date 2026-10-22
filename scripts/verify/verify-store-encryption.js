'use strict';
/**
 * scripts/verify-store-encryption.js —— 凭据库加密一致性体检（只读）。
 *
 * 用途：确认库里每一行密文都能被**当前**密钥解开。
 *
 * 为什么需要它：密钥与密文错配是本项目唯一不可逆的失效模式——`lib/crypto.js`
 * 在密钥文件缺失时会重新生成一把并写盘，而库里所有 token_enc 仍用旧钥加密，
 * 此后永远解不开；用户看到的只是「账号登录失效」，猜不到原因。启动校验
 * （startup-checks 的 checkEncryptionKey）只在「本次新生成了密钥且库里有密文行」
 * 时才 fatal，覆盖不了「密钥文件在、但内容被换掉」这类情形。
 *
 * 本脚本逐行试解，把错配当场指出来，不写任何数据。
 *
 * 运行：node scripts/verify-store-encryption.js
 * 退出码：0 = 全部可解；1 = 存在解不开的行；2 = 无法确定密钥（不做任何猜测）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const stateDir = path.join(ROOT, 'output', '.trae-api');

// 密钥解析与 lib/crypto.js 同规则，但**绝不触发生成**：密钥缺失时直接退出，
// 否则「体检」本身会写出一把新密钥，把不可逆失效变成既成事实。
function resolveKeySource() {
  const envKey = process.env.TRAE_API_ENCRYPT_KEY;
  if (envKey) return { where: '环境变量 TRAE_API_ENCRYPT_KEY', key: envKey };
  for (const f of [path.join(stateDir, 'encrypt.key'), path.join(ROOT, '.trae-api', 'encrypt.key')]) {
    if (fs.existsSync(f)) {
      const k = fs.readFileSync(f, 'utf-8').trim();
      if (k) return { where: f, key: k };
    }
  }
  return null;
}

const src = resolveKeySource();
if (!src) {
  console.error('[FATAL] 找不到加密密钥（既无 TRAE_API_ENCRYPT_KEY，也无 encrypt.key）。');
  console.error('        为避免生成新密钥造成不可逆失效，本脚本不继续执行。');
  process.exit(2);
}

const crypto = require('crypto');
const key = Buffer.from(src.key.padEnd(64, '0').substring(0, 64), 'hex');

function canDecrypt(enc) {
  if (enc == null || enc === '') return { ok: true, empty: true };
  if (typeof enc !== 'string') return { ok: false, reason: '值不是字符串' };
  const parts = enc.split(':');
  if (parts.length !== 3) return { ok: false, reason: '不是 iv:tag:data 三段格式' };
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'hex'));
    d.setAuthTag(Buffer.from(parts[1], 'hex'));
    d.update(parts[2], 'hex', 'utf8');
    d.final('utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

const dbFile = path.join(stateDir, 'trae-relay.db');
if (!fs.existsSync(dbFile)) {
  console.error(`[FATAL] 找不到凭据库：${dbFile}`);
  process.exit(2);
}

const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(dbFile, { readOnly: true });

const FIELD_SETS = [
  { table: 'accounts', idCol: 'id', fields: ['token_enc', 'refresh_token_enc', 'api_key_enc'] },
  { table: 'api_keys', idCol: 'id', fields: ['key_enc'] },
];

let bad = 0;
let checked = 0;
console.log(`密钥来源：${src.where}`);
console.log(`凭据库：${dbFile}\n`);

for (const { table, idCol, fields } of FIELD_SETS) {
  const present = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const cols = fields.filter((f) => present.includes(f));
  if (!cols.length) continue;
  const rows = db.prepare(`SELECT ${idCol} id, ${cols.join(', ')} FROM ${table}`).all();
  let tableBad = 0;
  for (const r of rows) {
    for (const f of cols) {
      if (r[f] == null || r[f] === '') continue;
      checked += 1;
      const v = canDecrypt(r[f]);
      if (!v.ok) {
        bad += 1;
        tableBad += 1;
        console.error(`  [错配] ${table}.${r.id}.${f}: ${v.reason}`);
      }
    }
  }
  console.log(`${table}: ${rows.length} 行，密文字段 ${cols.join('/')}，解不开 ${tableBad} 处`);
}

console.log(`\n共检查 ${checked} 个密文值，解不开 ${bad} 处。`);
if (bad) {
  console.error(
    '\n[FAIL] 存在无法用当前密钥解开的密文。常见原因：\n' +
    '  - encrypt.key 被替换或从备份恢复了旧版本；\n' +
    '  - 有程序用 TRAE_API_ENCRYPT_KEY 的另一把钥匙写过库（例如测试未隔离工作区时）。\n' +
    '  这些行对应的凭据已不可恢复，需要在面板重新登录/导入该账号。',
  );
  process.exit(1);
}
console.log('[OK] 全部密文可用当前密钥解开。');
