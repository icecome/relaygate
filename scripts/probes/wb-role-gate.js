'use strict';
/**
 * scripts/probes/wb-role-gate.js — 确认「只查 system」这条判据的边界与稳定性。
 *
 * 已证（wb-placement）：
 *   A1 system 装 13.6KB 全文      -> 11128
 *   A2 同一文本放 user 消息       -> 200   ← 只查 system
 *   B2 system 前半 + user 后半    -> 200
 *
 * 本脚本补齐边界：
 *   1) 阈值：system 里多长开始触发
 *   2) 角色变体：assistant / tool / developer 消息是否同样免检
 *   3) 首条 user 是否算 system（有些网关把首条 user 当 system 合并）
 *   4) 多轮累积：system 短 + 历史 user 长 是否累积触发
 *
 * 用法：node scripts/probes/wb-role-gate.js [模型]
 */
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:19900';
const MODEL = process.argv[2] || 'wb/deepseek-v4.1-flash';
const apiKeys = require('../../src/credentials/api-keys');
const KEY = apiKeys.revealKeyPlain(apiKeys.listKeys().find((k) => k.label === 'dsh-workbuddy').id);
const SYS = fs.readFileSync(path.join(__dirname, '..', '..', 'logs', '_dsh-system.txt'), 'utf8');

async function result(label, messages) {
  const body = { model: MODEL, stream: false, max_tokens: 8, messages };
  try {
    const r = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    const b = /11128/.test(t);
    console.log(`${label.padEnd(50)} -> ${r.status} ${b ? 'BLOCKED' : 'ok'}`);
    return b;
  } catch (e) {
    console.log(`${label.padEnd(50)} EXCEPTION ${e.message}`);
    return false;
  }
}

(async () => {
  const U = 'say ok';

  console.log('=== 1) system 长度阈值（用真实文本前缀）');
  for (const n of [1000, 2000, 3000, 4000, 5000, 6000, 7000, 9000, 11000, 13649]) {
    await result(`system ${String(n).padStart(5)} 字前缀`, [{ role: 'system', content: SYS.slice(0, n) }, { role: 'user', content: U }]);
  }

  console.log('\n=== 2) 角色变体（同一 13.6KB 文本）');
  await result('system', [{ role: 'system', content: SYS }, { role: 'user', content: U }]);
  await result('user', [{ role: 'user', content: SYS }, { role: 'user', content: U }]);
  await result('assistant', [{ role: 'system', content: 'You are a coding assistant.' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: SYS }, { role: 'user', content: U }]);
  await result('developer', [{ role: 'developer', content: SYS }, { role: 'user', content: U }]);

  console.log('\n=== 3) system 短 + 历史长（累计是否触发）');
  await result('短 system + 长 user 历史', [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: SYS },
    { role: 'assistant', content: 'understood' },
    { role: 'user', content: U },
  ]);

  console.log('\n=== 4) system 尾部（越靠后越远？）');
  await result('system 只放最后 3000 字', [{ role: 'system', content: SYS.slice(-3000) }, { role: 'user', content: U }]);
  await result('system 首 3000 + 末 3000', [{ role: 'system', content: SYS.slice(0, 3000) + SYS.slice(-3000) }, { role: 'user', content: U }]);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
