'use strict';
/** 提取 pi-ai 的 transcript 工具模块（resolveTranscript 所在文件）。 */
const fs = require('fs');
const path = require('path');
const ASAR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar');
const buf = fs.readFileSync(ASAR);
const jsonLen = buf.readUInt32LE(12);
const hdr = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
const DATA = 8 + buf.readUInt32LE(4);

function readFile(rel) {
  let node = hdr;
  for (const s of rel.split('/')) { node = node && node.files ? node.files[s] : undefined; if (!node) return null; }
  if (!node || node.files || node.size == null) return null;
  if (node.unpacked) {
    const p = ASAR + '.unpacked/' + rel;
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  return Buffer.from(buf.slice(DATA + Number(node.offset), DATA + Number(node.offset) + Number(node.size)));
}

const WANTS = [
  'dsh/node_modules/@earendil-works/pi-ai/dist/utils/transcript.js',
  'dsh/node_modules/@earendil-works/pi-ai/dist/utils/text.js',
  'dsh/node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js',
];
const OUT = path.join(__dirname, '..', '..', 'logs', '_dsh-asar');
for (const rel of WANTS) {
  const raw = readFile(rel);
  if (!raw) { console.log('miss:', rel); continue; }
  const safe = rel.replace(/[\\/]/g, '__');
  fs.writeFileSync(path.join(OUT, safe), raw);
  console.log('saved:', safe, (raw.length / 1024).toFixed(0) + 'KB');
}
