'use strict';
const fs = require('fs');
const p = 'C:\\opt\\workstations\\agents\\Qoder\\resources\\app.asar';
const b = fs.readFileSync(p);
const jsonLen = b.readUInt32LE(12);
const hdr = JSON.parse(b.slice(16, 16 + jsonLen).toString('utf8'));
const files = [];
function walk(node, dir) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = dir ? `${dir}/${name}` : name;
    if (child.files) walk(child, rel);
    else files.push(rel);
  }
}
walk(hdr, '');

const KW = ['package.json', 'main.', 'auth', 'login', 'token', 'api', 'model', 'point', 'sign', 'checkin', 'credit', 'task', 'agent', 'chat', 'qwen', 'flash', 'entitlement', 'plan', 'billing', 'reward', 'daily', 'config', 'host', 'endpoint', 'request', 'fetch', 'http', 'client', 'user', 'account'];
const interesting = files.filter((f) => {
  const l = f.toLowerCase();
  if (l === 'out/main/index.js' || l === 'out/main/package.json') return true;
  // 主进程业务代码：out/main 下的非 minified chunk（按大小筛，避免翻动资源）
  if (l.startsWith('out/main/') && (l.endsWith('.js') || l.endsWith('.json'))) return true;
  if (/\b(auth|login|token|api|model|point|sign|checkin|credit|reward|billing|entitlement|qwen|flash|endpoint|host|config)\b/.test(l)) return true;
  return false;
});

// 输出 out/main 下的全部 js/json（按路径分组），以及命中关键词的 renderer 文件
const mainFiles = files.filter((f) => f.startsWith('out/main/') && (f.endsWith('.js') || f.endsWith('.json')))
  .sort();
const rendererHits = files.filter((f) => f.startsWith('out/renderer/') && (/\b(auth|login|token|api|model|point|sign|checkin|credit|reward|billing|entitlement|qwen|flash|endpoint|host|config|agent)\b/.test(f.toLowerCase())) && f.endsWith('.js'))
  .sort();

const out = [];
out.push('=== out/main files (sorted) ===');
out.push(...mainFiles);
out.push('');
out.push('=== renderer keyword hits ===');
out.push(...rendererHits);
fs.writeFileSync('C:\\opt\\workstations\\project\\web\\RelayGate\\logs\\qoder-main-files.txt', out.join('\n'));
console.log(out.join('\n'));
