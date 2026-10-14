/**
 * 为卡片化表格自动补齐 data-label。
 *
 * 移动端（<768px）下 .card-table 规则把每个 td 渲染成「label: value」一行，
 * label 取自 td 的 data-label。手写容易遗漏，列序也容易错位，故按
 * 「表格 thead 的 th 文本」自动注入到该表格 JSX 行模板的对应 td 上。
 *
 * 用法：node scripts/add-data-labels.mjs [file ...]；不带参数时处理 src 下所有含 card-table 的文件。
 * 幂等：已有 data-label 的 td 会被跳过，重复运行安全。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

/** 从 th 行提取列名；操作类列无实际数据语义，用 null 表示不加 label。 */
function labelsFromHeader(headerLines) {
  const labels = [];
  for (const line of headerLines) {
    const m = line.match(/<th className="([^"]*)"[^>]*>([^<]*)</);
    if (!m) continue;
    const cls = m[1];
    const text = m[2].trim();
    // 操作列在卡片里单独占一行，不需要 label 前缀
    if (cls.includes('cell-act')) {
      labels.push(null);
      continue;
    }
    labels.push(text || null);
  }
  return labels;
}

function processFile(file) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('card-table')) return 0;
  const lines = text.split('\n');
  let applied = 0;

  // 找到每个 className 含 card-table 的 table 块
  for (let i = 0; i < lines.length; i += 1) {
    if (!/className="[^"]*card-table/.test(lines[i])) continue;

    // 收集 thead 区间的 th
    const theadStart = i;
    let theadEnd = -1;
    for (let j = theadStart; j < lines.length; j += 1) {
      if (j > theadStart && /<\/thead>/.test(lines[j])) {
        theadEnd = j;
        break;
      }
    }
    if (theadEnd < 0) continue;
    const labels = labelsFromHeader(lines.slice(theadStart, theadEnd));
    if (labels.length === 0) continue;

    // 表格结束行
    let tableEnd = lines.length - 1;
    for (let j = theadEnd; j < lines.length; j += 1) {
      if (/<\/table>/.test(lines[j])) {
        tableEnd = j;
        break;
      }
    }

    // tbody 行模板里的 td：跳过 thead 区间，按出现顺序循环贴 label
    let col = 0;
    for (let k = theadEnd + 1; k < tableEnd; k += 1) {
      const line = lines[k];
      const m = line.match(/^(\s*)<td className="([^"]*)"([^>]*)>/);
      if (!m) continue;
      const label = labels[col % labels.length];
      col += 1;
      if (!label) continue;
      if (/data-label=/.test(line)) continue; // 幂等
      lines[k] = line.replace(
        /^(\s*)<td className="([^"]*)"([^>]*)>/,
        `$1<td className="$2"$3 data-label="${label}">`,
      );
      applied += 1;
    }
  }

  if (applied > 0) writeFileSync(file, lines.join('\n'), 'utf8');
  return applied;
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : walk(srcDir).filter((f) => readFileSync(f, 'utf8').includes('card-table'));

let total = 0;
for (const f of targets) {
  const n = processFile(f);
  if (n) {
    total += n;
    console.log(`  ${n} 个 data-label → ${f.slice(srcDir.length + 1)}`);
  }
}
console.log(`合计注入 ${total} 个 data-label`);