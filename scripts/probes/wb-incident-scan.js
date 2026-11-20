'use strict';
/**
 * scripts/probes/wb-incident-scan.js — 扫描 DSH 会话日志，还原 11128 事故时段的请求形状。
 *
 * 背景：11-13 / 11-19 各出现 2 条真实 11128（wb/hy4free、wb/deepseek-v4.1-flash），
 * 但同期 wb-repro-split.js 逐组合全 200。需要确认当时请求里 system 的长度与 role
 * 形状，判断是不是「request/header 的 system 与 system/message 并存」之类的
 * 双 system 形状触发上游校验。
 *
 * 用法：node scripts/probes/wb-incident-scan.js [日期正则，默认 2026-11-13|2026-11-19]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(process.env.USERPROFILE || '', '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SINCE = process.argv[2] || '2026-11-(13|19)T0[123]';

function dec(buf) {
  const fr = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) >= 0) { fr.push(i); i += 4; }
  if (!fr.length) return zlib.zstdDecompressSync(buf).toString('utf8');
  let out = '';
  for (let k = 0; k < fr.length; k++) {
    const s = fr[k];
    const e = k + 1 < fr.length ? fr[k + 1] : buf.length;
    try { out += zlib.zstdDecompressSync(buf.slice(s, e)).toString('utf8'); } catch { /* 残帧 */ }
  }
  return out;
}

function walk(d, o = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, o);
    else if (e.name.endsWith('.jsonl.zstd')) o.push({ f, m: fs.statSync(f).mtimeMs });
  }
  return o;
}

const files = walk(ROOT).sort((a, b) => b.m - a.m).slice(0, 60);
const RE = new RegExp(SINCE);
for (const { f } of files) {
  let t;
  try { t = dec(fs.readFileSync(f)); } catch { continue; }
  if (!t.includes('"provider":"wb"') && !t.includes('wb/deepseek-v4.1-flash') && !t.includes('wb/hy4free')) continue;
  const sess = path.basename(path.dirname(f));
  for (const ln of t.split('\n')) {
    if (!ln.includes('request/header') && !ln.includes('system/message')) continue;
    let j;
    try { j = JSON.parse(ln); } catch { continue; }
    const time = new Date(j.time || 0).toISOString();
    if (!RE.test(time)) continue;
    if (j.type === 'request/header') {
      const h = (j.data && j.data.header) || {};
      console.log('[HDR]', time, sess.slice(0, 24), JSON.stringify(h.config || {}),
        'tools=' + (h.tools || []).length,
        'systemLen=', h.system != null ? String(h.system).length : (h.systemPrompt != null ? String(h.systemPrompt).length : '∅'),
        'keys=' + Object.keys(h).join(','));
    } else if (j.type === 'system/message') {
      const c = j.data && j.data.message && j.data.message.content;
      const len = typeof c === 'string' ? c.length : JSON.stringify(c || '').length;
      console.log('[SYS]', time, sess.slice(0, 24), 'turn=' + j.data.turn, 'step=' + j.data.step,
        'len=' + len, 'role=' + (j.data.message && j.data.message.role));
    }
  }
}
