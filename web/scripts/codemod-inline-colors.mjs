/**
 * 内联单属性样式 → 语义类的批量改写（默认 dry-run，不写盘）。
 *
 * ## 为什么只处理「单个 color / background 属性」这一种
 *
 * 409 个内联 style 块里：
 *   - 298 个只写了一个 color
 *   -  28 个只写了一个 background
 *   -  19 个只写了 width/height
 *   -  64 个是多属性或含动态表达式
 *
 * 前两类是**机械可逆**的：值只有十余种，目标类与值一一对应，不存在
 * 「需要人判断这里该用什么色」的余地。后两类不在本脚本范围内：
 * 宽高是几何量，动态表达式是运行时状态，机械替换会把错误固化下来。
 *
 * ## 为什么默认 dry-run
 *
 * 这是一次跨 40 个文件的批量改写。先看清单、再单独执行 --write，
 * 中间可以被人拦下来复核，而不是一条命令改完 200 处。
 *
 * ## 可重复执行
 *
 * 目标类已存在时跳过；值不在映射表里时跳过（并把条目打印出来供人工裁决）。
 *
 * 用法：
 *   node scripts/codemod-inline-colors.mjs            # 只报告
 *   node scripts/codemod-inline-colors.mjs --write    # 落盘
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const WRITE = process.argv.includes('--write');

/**
 * 值 → 类名映射。
 *
 * 只收纯令牌字符串。带条件表达式的（例如 `e.tone === 'ok' ? a : b`）不在表里，
 * 会被自动跳过 —— 它们的正确解法是抽一个 tone→class 的映射函数，而不是内联。
 */
const COLOR_TO_CLASS = {
  'var(--rg-text-primary)': 'fg-1',
  'var(--rg-text-secondary)': 'fg-2',
  'var(--rg-text-tertiary)': 'fg-3',
  'var(--rg-text-disabled)': 'fg-disabled',
  'var(--rg-brand-600)': 'fg-brand',
  'var(--rg-state-success)': 'fg-ok',
  'var(--rg-state-warning)': 'fg-warn',
  'var(--rg-state-error)': 'fg-danger',
};

const BACKGROUND_TO_CLASS = {
  'var(--rg-bg-base)': 'surface-base',
  'var(--rg-bg-secondary)': 'surface-2',
  'var(--rg-bg-tertiary)': 'surface-3',
  transparent: null, // 有意跳过：交互动画里的 transparent 是状态而非表面
};

/**
 * 匹配「className 后紧跟只含一个 color 或 background 的 style」。
 *
 * 刻意要求 className 用双引号、style 与它之间只有空白、且值用单引号：
 * 这样不会误伤 className={cx(...)}、跨行拼接、或值里含模板字符串的情况。
 */
const PATTERN = /className="([^"]*)"([ \t]*)style=\{\{[ \t]*(color|background):[ \t]*'([^']+)'[ \t]*\}\}/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const report = [];
const skipped = [];
let totalHits = 0;

for (const file of walk(srcDir)) {
  const before = readFileSync(file, 'utf8');
  let hits = 0;
  const rel = relative(srcDir, file).replace(/\\/g, '/');

  const after = before.replace(PATTERN, (whole, cls, _gap, prop, value) => {
    const table = prop === 'color' ? COLOR_TO_CLASS : BACKGROUND_TO_CLASS;
    const target = table[value];
    if (!target) {
      if (prop === 'background' && value === 'transparent') return whole;
      skipped.push(`${rel}  ${prop}: '${value}'`);
      return whole;
    }
    // 类已存在就不重复追加（脚本可重复执行）
    if (new RegExp(`(^|\\s)${target}(\\s|$)`).test(cls)) return whole;
    hits += 1;
    return `className="${cls} ${target}"`;
  });

  if (hits > 0) {
    totalHits += hits;
    report.push({ file: rel, hits });
    if (WRITE) writeFileSync(file, after, 'utf8');
  }
}

report.sort((a, b) => b.hits - a.hits);
console.log(`${WRITE ? '已改写' : '可改写'} ${totalHits} 处，涉及 ${report.length} 个文件\n`);
for (const r of report) console.log(`  ${String(r.hits).padStart(4)}  ${r.file}`);

if (skipped.length) {
  console.log(`\n跳过 ${skipped.length} 处（值不在映射表，需人工裁决或抽 tone→class 函数）：`);
  for (const s of skipped.slice(0, 40)) console.log(`  ${s}`);
  if (skipped.length > 40) console.log(`  …… 另有 ${skipped.length - 40} 处`);
}

if (!WRITE) {
  console.log('\n这是 dry-run。确认清单后运行：');
  console.log('  node scripts/codemod-inline-colors.mjs --write');
  console.log('落盘后立刻跑：');
  console.log('  node scripts/check-ui-consistency.mjs --update && npx tsc -b && npx eslint .');
}