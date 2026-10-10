/**
 * CSS 令牌引用校验。
 *
 * 防止出现「引用了不存在的 CSS 变量」这类静默失效：
 * 组件里写 var(--rg-foo) 而令牌层没定义 --rg-foo 时，浏览器静默回退，
 * 视觉上只是「没生效」，不会报错，人工也难发现。
 *
 * 本脚本把 global.css 的 --rg-*: 定义与 src 下的 var(--rg-*) 引用做差集，
 * 差集非空即退出码 1。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const cssFile = join(srcDir, 'styles', 'global.css');

const css = readFileSync(cssFile, 'utf8');
const defined = new Set([...css.matchAll(/(--rg-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(p);
  }
  return out;
}

const used = new Map();
for (const file of walk(srcDir)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/var\((--rg-[a-z0-9-]+)/g)) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(file.slice(srcDir.length + 1));
  }
}

const missing = [...used.keys()].filter((v) => !defined.has(v)).sort();

if (missing.length) {
  console.error('引用了未定义的 CSS 令牌：');
  for (const v of missing) {
    console.error(`  ${v}  ← ${[...used.get(v)].join(', ')}`);
  }
  console.error(`\n令牌层共定义 ${defined.size} 个变量，实际引用 ${used.size} 个。`);
  process.exit(1);
}

console.log(`CSS 令牌校验通过：${used.size} 个引用全部有定义（令牌层共 ${defined.size} 个）。`);