/**
 * 手写卡片容器 → .subcard* 的批量替换（默认 dry-run）。
 *
 * ## 目标形态
 *
 * 违规：`className="rounded-lg border p-3 ..."` + `style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}`
 *       —— 这是 .subcard-soft 的手写版，7 处逐字重复。
 *
 * 替换：`className="subcard-soft ..."`，并删掉仅剩 borderColor/background 的 style 块。
 *
 * ## 为什么不做成通用正则
 *
 * 每处的 class 尾巴不同（有的带 text-aux、有的带 flex flex-col gap-1），
 * 且 style 块里可能同时有 borderColor 与 background 两个键。
 * 这里按「整块匹配 + 精确改写」处理，只匹配已知的 7 个签名的变体。
 *
 * 用法：
 *   node scripts/codemod-card-containers.mjs           # 只报告
 *   node scripts/codemod-card-containers.mjs --write   # 落盘
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const WRITE = process.argv.includes('--write');

/**
 * 替换规则。
 *
 * grep / sub 都是字面字符串（不跑正则），这样 diff 可预期、不会误伤。
 * 每条规则的 `sub` 必须是「等价或更严格」的改写：不能顺手删掉内容。
 */
const RULES = [
  // 灰底软卡片：最近一轮结果、定时任务设置（QoderOps / ZcodeOps 各两处）
  {
    name: 'subcard-soft + text-aux + gap-1',
    grep: `          className="rounded-lg border p-3 text-aux flex flex-col gap-1"
          style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
`,
    sub: `          className="subcard-soft text-aux flex flex-col gap-1"
`,
  },
  {
    name: 'subcard-soft + gap-2.5',
    grep: `        className="rounded-lg border p-3 flex flex-col gap-2.5"
        style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
`,
    sub: `        className="subcard-soft flex flex-col gap-2.5"
`,
  },
  // ImportRaccoonDialog：灰底软卡片 + mt-3
  {
    name: 'subcard-soft + mt-3',
    grep: `      <div className="rounded-lg border p-3 mt-3 flex flex-col gap-2"
        style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
`,
    sub: `      <div className="subcard-soft mt-3 flex flex-col gap-2"
`,
  },
  // TokenStatsPage 口径卡：白底、p-4
  {
    name: 'subcard（口径卡，白底 p-4）',
    grep: `      className="rounded-lg border p-4 min-w-0"
      style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-base)' }}
`,
    sub: `      className="subcard p-4 min-w-0"
`,
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * 换行归一。
 *
 * 仓库里的 .tsx 是 CRLF（Windows checkout，autocrlf 未开），而本文里的
 * 匹配串是按 LF 写的。直接在原文上 replace 会全部落空 —— 这是第一次
 * dry-run 报「0 处」的原因。
 *
 * 处理：读入时把 CRLF 统一成 LF 做匹配，写回时再按原文件的换行风格还原。
 * 不做这一步，脚本在 Windows 上是静默失效的（不报错、不匹配、什么都不改）。
 */
const hasCRLF = (text) => text.includes('\r\n');
const toLF = (text) => text.replace(/\r\n/g, '\n');
const restore = (text, crlf) => (crlf ? text.replace(/\n/g, '\r\n') : text);

const hits = [];

for (const file of walk(srcDir)) {
  const raw = readFileSync(file, 'utf8');
  const crlf = hasCRLF(raw);
  const before = toLF(raw);
  let after = before;
  const rel = relative(srcDir, file).replace(/\\/g, '/');

  for (const rule of RULES) {
    if (!after.includes(rule.grep)) continue;
    const count = after.split(rule.grep).length - 1;
    after = after.split(rule.grep).join(rule.sub);
    hits.push({ file: rel, rule: rule.name, count });
  }

  if (after !== before) {
    if (WRITE) writeFileSync(file, restore(after, crlf), 'utf8');
  }
}

const total = hits.reduce((n, h) => n + h.count, 0);
console.log(`${WRITE ? '已替换' : '可替换'} ${total} 处，涉及 ${new Set(hits.map((h) => h.file)).size} 个文件\n`);
for (const h of hits) console.log(`  ${String(h.count).padStart(2)}  ${h.file}  ← ${h.rule}`);

if (!WRITE) {
  console.log('\n这是 dry-run。确认清单后运行：');
  console.log('  node scripts/codemod-card-containers.mjs --write');
}

/* 替换完仍需人工处理的两处（结构不同，不套 .subcard）：
 *   SetupGate.tsx:226    rounded-md border p-3 mb-3      —— 对话框内的提示块，走 .note
 *   NotifyBackupPanel:634  rounded-lg border overflow-x-auto —— 表格滚动容器，走 .table-wrap
 */