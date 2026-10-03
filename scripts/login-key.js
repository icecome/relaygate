'use strict';
/**
 * scripts/login-key.js — 登录密钥 CLI（创建 / 重置 / 列表）。
 *
 * 用法：
 *   node scripts/login-key.js create [label]
 *   node scripts/login-key.js reset  [label]
 *   node scripts/login-key.js list
 *
 * 明文仅打印一次；丢失请 reset。
 */
require('dotenv').config();
const apiKeys = require('../src/credentials/api-keys');

const cmd = String(process.argv[2] || '').toLowerCase();
const labelArg = process.argv[3] || 'login';

function printKey(k) {
  console.log('');
  console.log('  id:       ', k.id);
  console.log('  label:    ', k.label);
  console.log('  kind:     ', k.kind);
  console.log('  createdAt:', k.createdAt);
  console.log('');
  console.log('  ┌──────────────── 登录密钥明文（仅显示一次，请立即保存）────────────────┐');
  console.log('  │');
  console.log('  │  ' + k.key);
  console.log('  │');
  console.log('  └──────────────────────────────────────────────────────────────────────┘');
  console.log('');
}

try {
  if (cmd === 'create') {
    if (apiKeys.hasLoginKey()) {
      console.error('已存在启用的登录密钥。请改用 reset，或先在管理面禁用后重试。');
      process.exit(1);
    }
    const k = apiKeys.createKey({ label: labelArg, kind: 'login' });
    printKey(k);
    console.log('请在管理面板「设置 → 登录密钥」粘贴保存。');
  } else if (cmd === 'reset') {
    const k = apiKeys.resetLoginKey({ label: labelArg });
    printKey(k);
    console.log('旧登录密钥已全部失效。请在管理面板更新保存的密钥。');
  } else if (cmd === 'list') {
    const rows = apiKeys.listKeys({ kind: 'login' });
    if (!rows.length) {
      console.log('(无登录密钥。运行: node scripts/login-key.js create)');
    } else {
      for (const r of rows) {
        console.log(`${r.enabled ? '[on] ' : '[off]'} ${r.id}  ${r.label || '-'}  lastUsed=${r.lastUsedAt || '-'}  hint=${r.hint}`);
      }
    }
  } else {
    console.log('用法: node scripts/login-key.js <create|reset|list> [label]');
    process.exit(1);
  }
} catch (e) {
  console.error('[login-key]', e.message);
  process.exit(1);
}
