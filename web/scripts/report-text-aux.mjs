/**
 * 剩下的「text-aux 无 fg」分类清单（只报告，不改写）。
 *
 * 剩余 106 处里，实际分三类：
 *   A 容器级：className 在容器上，子元素各自定色 —— 正确，不该加 fg
 *   B 表格单元格：父级 .td 已定色 —— 正确
 *   C 真正的漏配：既不是容器，也没有自带颜色的父级
 *
 * 这个脚本只把 C 类挑出来，供人工逐条判断该用 fg-2 还是 fg-3。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

/** 自带 color 的类；与 check-ui-consistency 的 SELF_COLORED 保持同步 */
const SELF_COLORED =
  /\b(td|th|btn|field|select|pill|note|link|rail-name|metric-key|ent-amount|panel-title|panel-desc)\b/;

/** 容器级：这些类说明这个元素是用来装子节点的，颜色由子节点决定 */
const CONTAINER =
  /(flex|grid|subcard|panel|card|inline-flex|inline-grid)/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const buckets = { A: [], B: [], C: [] };

for (const file of walk(srcDir)) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(srcDir, file).replace(/\\/g, '/');
  for (const m of text.matchAll(/className="([^"]*\btext-aux\b[^"]*)"/g)) {
    const cls = m[1];
    if (/\bfg-(1|2|3|brand|ok|warn|danger|disabled)\b/.test(cls)) continue;
    const lineNo = text.slice(0, m.index).split('\n').length;
    const row = { rel, lineNo, cls };
    if (SELF_COLORED.test(cls)) buckets.B.push(row);
    else if (CONTAINER.test(cls)) buckets.A.push(row);
    else buckets.C.push(row);
  }
}

const label = {
  A: '容器级（子元素各自定色）—— 不改',
  B: '已由自带色的类覆盖（.td/.th/...）—— 不改',
  C: '疑似漏配 —— 需逐条裁决',
};

console.log(`\n总 ${buckets.A.length + buckets.B.length + buckets.C.length} 处\n`);
for (const k of ['A', 'B', 'C']) {
  console.log(`## ${k} ${label[k]}：${buckets[k].length} 处`);
  if (k === 'C') {
    for (const r of buckets[k]) {
      console.log(`  ${r.rel}:${r.lineNo}  ${r.cls}`);
    }
  }
  console.log('');
}