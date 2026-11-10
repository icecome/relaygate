'use strict';
/** 从 zh-cn 资源包解出 errorCode.111xx 文案（11128 渠道校验语义核对用）。 */
const fs = require('fs');
const s = fs.readFileSync(process.argv[2] || 'logs/_zh_new.js', 'utf8');
const re = /"errorCode\.(111\d\d)(\.desc)?":\s*"((?:[^"\\]|\\.)*)"/g;
let m;
const out = {};
while ((m = re.exec(s))) out[m[1] + (m[2] || '')] = m[3];
for (const k of Object.keys(out).sort()) console.log(k, '=', out[k]);
if (!Object.keys(out).length) console.log('(no errorCode.111xx matches)');
