/**
 * 跨列单元格的内联 background → .td-spanned（默认 dry-run）。
 *
 * 匹配：`<td className="td" colSpan={N} style={{ background: 'var(--rg-bg-secondary)' }}>`
 *      以及 colSpan 在前、style 在后的变体。
 *
 * 只改写 className 恰好是 "td" 的跨列单元格 —— 带其他类（例如已经有
 * text-aux）的说明它还有别的职责，需要人看一眼再改。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const WRITE = process.argv.includes('--write');

const PATTERN =
  /<td className="td"([^>]*?)style=\{\{\s*background:\s*'var\(--rg-bg-secondary\)'\s*\}\}/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const report = [];
let total = 0;

for (const file of walk(srcDir)) {
  const before = readFileSync(file, 'utf8');
  let hits = 0;
  const after = before.replace(PATTERN, (_w, mid) => {
    hits += 1;
    // mid 里保留了 colSpan 等其余属性，原样搬过去
    return `<td className="td td-spanned"${mid.trimEnd()}`;
  });
  if (hits > 0) {
    total += hits;
    report.push({ file: relative(srcDir, file).replace(/\\/g, '/'), hits });
    if (WRITE) writeFileSync(file, after, 'utf8');
  }
}

console.log(`${WRITE ? '已改写' : '可改写'} ${total} 处\n`);
for (const r of report) console.log(`  ${String(r.hits).padStart(2)}  ${r.file}`);
if (!WRITE) console.log('\ndry-run。确认后：node scripts/codemod-spanned-cols.mjs --write');