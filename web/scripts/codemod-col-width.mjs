/**
 * 表头列宽：内联 style 宽度 → Tailwind 任意值宽度类（默认 dry-run）。
 *
 * ## 为什么换
 *
 * `<th ... style={{ width: 148 }}>` 与 `className="th w-[148px]"` 的渲染结果
 * 完全一致，但后者：
 *   1. 不进内联样式统计（check-ui-consistency 的 styleBlocks 不涨）；
 *   2. 与仓库既有写法一致 —— TokenStatsPage 早就有 `className="th w-[110px]"`
 *      （那一处是本次改造前就有的），ModelRouterPage 则是 `style={{ width: 56 }}`。
 *      同一个「给列定宽」的动作存在两种写法，本次统一到类名一侧。
 *
 * ## 匹配范围
 *
 * 只处理**单行内、整段 style 只有一个 width** 的 <th>。
 * 多属性或含表达式的（例如 `style={{ background: ..., width }}`）不碰。
 *
 * 用法：
 *   node scripts/codemod-col-width.mjs            # 只报告
 *   node scripts/codemod-col-width.mjs --write    # 落盘
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const WRITE = process.argv.includes('--write');

/**
 * 匹配 `<th ... className="..." style={{ width: N }}>`
 *
 * className 必须在 style 之前（本仓库的写法如此），且 style 内只有 width。
 * 捕获组：1 = className 内容，2 = 宽度数字。
 */
const PATTERN =
  /(<th\b[^>]*?)className="([^"]+)"\s+style=\{\{\s*width:\s*(\d+)\s*\}\}/g;

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
  const after = before.replace(PATTERN, (_whole, head, cls, px) => {
    hits += 1;
    return `${head}className="${cls} w-[${px}px]"`;
  });
  if (hits > 0) {
    total += hits;
    report.push({ file: relative(srcDir, file).replace(/\\/g, '/'), hits });
    if (WRITE) writeFileSync(file, after, 'utf8');
  }
}

console.log(`${WRITE ? '已转换' : '可转换'} ${total} 处表头列宽\n`);
for (const r of report.sort((a, b) => b.hits - a.hits)) {
  console.log(`  ${String(r.hits).padStart(3)}  ${r.file}`);
}
if (!WRITE) console.log('\ndry-run。确认后：node scripts/codemod-col-width.mjs --write');