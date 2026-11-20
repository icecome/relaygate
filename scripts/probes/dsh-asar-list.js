'use strict';
/** 列出 DSH asar 中 dsh/ lib/ 下的 JS 文件与大小。 */
const fs = require('fs');
const path = require('path');
const ASAR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar');
const buf = fs.readFileSync(ASAR);
const jsonLen = buf.readUInt32LE(12);
const hdr = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (child.files) walk(child, p);
    else if (/\.js$/.test(p) && (p.startsWith('dsh/') || p.startsWith('lib/')) && child.size > 20000) console.log(p, child.size);
  }
}
walk(hdr, '');
