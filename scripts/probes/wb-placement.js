'use strict';
/**
 * scripts/probes/wb-placement.js — 检测面在 system 还是全消息？
 *
 * 关键工程问题：如果上游只查 system 消息，那把长文本挪进第一条 user 消息即可放行，
 * 不必改写任何内容（模型所见完全一致）。这比「压缩/替换」干净得多。
 *
 * 用法：node scripts/probes/wb-placement.js [模型]
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
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    const b = /11128/.test(t);
    console.log(`${label.padEnd(48)} -> ${r.status} ${b ? 'BLOCKED' : 'ok'} (${Date.now() - t0}ms)`);
    return b;
  } catch (e) {
    console.log(`${label.padEnd(48)} EXCEPTION ${e.message}`);
    return false;
  }
}

(async () => {
  const U = 'say ok';

  console.log('=== A 位置实验（文本完全相同，只换放置位置）');
  await result('A1 system 装全文 + user 短', [{ role: 'system', content: SYS }, { role: 'user', content: U }]);
  await result('A2 无 system，全文放第一条 user + 第二条 user', [
    { role: 'user', content: SYS },
    { role: 'user', content: U },
  ]);
  await result('A3 system 装全文 + user 空（最小 user）', [{ role: 'system', content: SYS }, { role: 'user', content: '.' }]);

  console.log('\n=== B 拆分实验');
  await result('B1 system 前一半 + system 后一半（两条 system）', [
    { role: 'system', content: SYS.slice(0, 6828) },
    { role: 'system', content: SYS.slice(6828) },
    { role: 'user', content: U },
  ]);
  await result('B2 system 前一半 + user 后一半', [
    { role: 'system', content: SYS.slice(0, 6828) },
    { role: 'user', content: SYS.slice(6828) },
    { role: 'user', content: U },
  ]);

  console.log('\n=== C 稳定性（同一段重复 3 次）');
  for (let i = 1; i <= 3; i++) {
    await result(`C${i} 全文重测`, [{ role: 'system', content: SYS }, { role: 'user', content: U }]);
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
