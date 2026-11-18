/**
 * UI 一致性闸门（ratchet 模式）。
 *
 * ## 为什么需要它
 *
 * 本项目已经有一套完整的令牌层（global.css 的 --rg-*）与基础组件（shared/ui），
 * 但实现层大量绕过它们：内联 style 直接引用 var(--rg-*)、原生标签不带组件的类、
 * 字号用 text-[13px] 硬编码。这类问题不会报错、不会让页面白屏，只会让
 * 「改一处设计规范、全站生效」这件事失效 —— 人工 review 很难拦住增量。
 *
 * ## 为什么是 ratchet 而不是一刀切失败
 *
 * 现存 400+ 处内联 style 是历史积累，一次性清零等于重写全部页面，风险远大于收益。
 * 这里的判据是「不许变多」：当前数量记为预算，任何一条超预算即失败。
 * 每完成一个阶段的重构，用 `--update` 把预算下调到新值，闸门只会越来越紧。
 *
 * ## 用法
 *
 *   node scripts/check-ui-consistency.mjs            # 校验（超预算退出码 1）
 *   node scripts/check-ui-consistency.mjs --update   # 重写预算为当前值
 *   node scripts/check-ui-consistency.mjs --report   # 只打印，永不失败
 *
 * 零依赖：只用 node:fs / node:path，与本目录的 check-css-tokens.mjs 同风格。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const srcDir = join(webRoot, 'src');
const baselineFile = join(here, 'ui-consistency-baseline.json');

const args = new Set(process.argv.slice(2));
const MODE_UPDATE = args.has('--update');
const MODE_REPORT = args.has('--report');

/** 递归收集源码文件，统一成正斜杠相对路径。 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * 剥掉注释后再计数。
 *
 * 不做这一步会有一类固定的误报：文档注释里写着 `<input type="date">` 这样的
 * 示例片段（KeyPolicyDialog 的 isoToDateInput 注释就是），计数规则会把它当成
 * 真实标签。这类误报最危险的地方是它会让人开始怀疑整份报告，最终忽略所有告警。
 *
 * 只剥块注释与整行注释，不碰行尾注释 —— 行尾注释里的标签同样可能是示例，
 * 但那段文字在真实代码之后，剥与不剥对计数影响小，而误剥会破坏结构。
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * 从 `style={{` 起，按花括号配平截取整个样式对象。
 *
 * 不能简单地找 `}}`：对象里可能有嵌套（例如 `style={{ gridTemplateColumns: dense ? a : b }}`
 * 没问题，但 `style={{ boxShadow: cond ? 'a' : 'b' }}` 会遇到三元表达式里的引号）。
 * 按 depth 配平是唯一稳妥的做法。
 */
function sliceStyleBlocks(text) {
  const blocks = [];
  const needle = 'style={{';
  let at = text.indexOf(needle);
  while (at >= 0) {
    let i = at + needle.length - 1;
    let depth = 0;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(text.slice(at, i + 1));
    at = text.indexOf(needle, i + 1);
  }
  return blocks;
}

/**
 * 允许清单：结构性自定义触发器。
 *
 * 这些位置**应该**是裸 <button> —— 它们不是「按钮」，而是整行/整卡/整项的
 * 点击区域，套 .btn 会带上 32px 高度、居中、边框，破坏布局。
 * 清单在这里按文件逐个点名，而不是给规则放宽阈值：放宽会让新增的漏用
 * 一起被放过，点名则要求每次新增都必须来这里写一行理由。
 *
 * 键是相对 src 的路径，值是「该文件允许的裸 button 数量」。
 */
const RAW_BUTTON_ALLOWLIST = {
  // 卡头展开触发器：整块卡头可点
  'features/overview/MetricCard.tsx': 1,
  // 权益总览整行展开：ent-head，grid 布局
  'features/accounts/EntitlementOverview.tsx': 1,
  // 通知渠道开关：带 aria-pressed 的整块开关
  'features/ops/NotifyBackupPanel.tsx': 1,
  // 环形图图例项：整行 hover 高亮
  'features/stats/TokenMixRing.tsx': 1,
  // 详情表里的「查看」文字链（跨页跳转，待改为 <Link>）
  'features/overview/OverviewPage.tsx': 3,
  // 命令面板结果项：role=option 的列表行
  'app/CommandMenu.tsx': 1,
  // 顶栏搜索框触发器：固定 220px 宽的伪输入框
  'app/AppLayout.tsx': 1,
  // 表格内联编辑入口：虚线下划线的表格内文字
  'features/accounts/AccessKeysPage.tsx': 1,
  'features/accounts/CredentialsPage.tsx': 1,
  // shared/ui 内部：Button 自身、Segmented 的两个分支、菜单项
  'shared/ui/index.tsx': 3,
  'shared/ui/Menu.tsx': 1,
};

/**
 * 规则定义。
 *
 * 每条规则给出：id、说明、以及从单个文件文本里数出计数的函数。
 * 计数口径刻意偏保守（宁可少报，也不要制造一批误报让人习惯性忽略）：
 * SVG 的 fill/stroke 字面色值是图形属性，不是主题色，因此 hex 规则排除它们。
 */
const RULES = [
  {
    id: 'styleBlocks',
    title: '内联 style 对象总数',
    hint: '静态外观应落在 global.css 的类里；只有随数据变化的几何量（宽高、角度、色阶下标）允许内联。',
    count: (text) => sliceStyleBlocks(text).length,
  },
  {
    id: 'inlineTokenRefs',
    title: '内联 style 内引用 var(--rg-*) 的次数',
    hint: '这是「令牌有了、但没有对应的类」最直接的证据：写 var(--rg-x) 说明作者知道该用令牌，却被迫内联。',
    count: (text) =>
      sliceStyleBlocks(text).reduce((n, b) => n + (b.match(/var\(--rg-/g)?.length ?? 0), 0),
  },
  {
    id: 'rawButtonNoBtnClass',
    title: '未使用 .btn 类的原生 <button>（已扣允许清单）',
    hint: '自定义触发器（卡头、菜单项、列表行）可以不带 .btn，但必须登记到 RAW_BUTTON_ALLOWLIST 并写明理由。',
    count: (text) => {
      let n = 0;
      for (const m of text.matchAll(/<button\b[^>]*>/g)) {
        if (!/\bbtn\b/.test(m[0])) n += 1;
      }
      return n;
    },
    /** 扣掉允许清单里点名的数量；扣到 0 为止，不会因写多而掩盖别处新增 */
    allow: (relPath, n) => Math.max(0, n - (RAW_BUTTON_ALLOWLIST[relPath] ?? 0)),
  },
  {
    id: 'rawTextInputNoField',
    title: '未使用 .field 类的文本型 <input>',
    hint: 'checkbox / radio / file / hidden 本来就该是原生控件；这里只数文本、数字、日期、搜索这几类。',
    count: (text) => {
      let n = 0;
      for (const m of text.matchAll(/<input\b[^>]*>/g)) {
        const tag = m[0];
        const typeMatch = tag.match(/type="([a-z]+)"/);
        const type = typeMatch ? typeMatch[1] : 'text';
        if (['checkbox', 'radio', 'file', 'hidden', 'range', 'color'].includes(type)) continue;
        if (!/\bfield\b/.test(tag)) n += 1;
      }
      return n;
    },
  },
  {
    id: 'hardcodedTextPx',
    title: '硬编码字号 text-[Npx]',
    hint: '字号阶梯由 .text-page / .text-block / .text-read / .text-hero / .text-aux / .text-unit 承担。',
    count: (text) => text.match(/text-\[\d+px\]/g)?.length ?? 0,
  },
  {
    id: 'literalHexColors',
    title: '非 SVG 的字面十六进制颜色',
    hint: '组件层只允许引用 --rg-* 语义变量；字面值一旦出现，换主题就会漏改。',
    count: (text) => {
      // 先摘掉 SVG 的图形属性（fill/stroke/stopColor/floodColor），它们表达图形而非主题色
      const stripped = text.replace(
        /\b(fill|stroke|stopColor|floodColor|color)="#[0-9a-fA-F]{3,8}"/g,
        '',
      );
      return stripped.match(/#[0-9a-fA-F]{6}\b/g)?.length ?? 0;
    },
  },
  {
    id: 'textAuxNoFg',
    title: '用了 .text-aux 却没配文字色类',
    hint: '.text-aux 只给字号与行高（12px/1.5），不含颜色。没配 .fg-N 时颜色取决于父级继承，同一段辅助文字在不同容器里深浅不一 —— 这正是 183 处内联 color 的成因。已有其他类定色的（.td / .th / .btn / .field / .pill / .note / .link）不计。',
    count: (text) => {
      /**
       * 自带 color 声明的类：出现在同一个 className 里时，
       * .text-aux 只承担字号，颜色由那个类给，不算漏配。
       */
      const SELF_COLORED =
        /\b(td|th|btn|field|select|pill|note|link|rail-name|metric-key|ent-amount|panel-title|panel-desc)\b/;
      let n = 0;
      for (const m of text.matchAll(/className="([^"]*\btext-aux\b[^"]*)"/g)) {
        const cls = m[1];
        if (/\bfg-(1|2|3|brand|ok|warn|danger|disabled)\b/.test(cls)) continue;
        if (SELF_COLORED.test(cls)) continue;
        n += 1;
      }
      return n;
    },
  },
  {
    id: 'inlineColSpanBg',
    title: '内联 background 的跨列单元格',
    hint: '表格内的展开行、汇总行用 <td colSpan={N} style={{ background }}> 直接写表面色。应改用 .td-spanned，让「展开行的底色」只有一个定义。',
    count: (text) =>
      text.match(/<td\b[^>]*colSpan=\{[^}]+\}[^>]*style=\{\{\s*background:\s*'var\(--rg-bg-/g)?.length ?? 0,
  },
];

const files = walk(srcDir);
const perRule = new Map(RULES.map((r) => [r.id, { total: 0, byFile: new Map() }]));

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  // 注释里的示例标签/样式不算实现，先剥掉再计数（见 stripComments 的说明）
  const text = stripComments(raw);
  const rel = relative(srcDir, file).replace(/\\/g, '/');
  for (const rule of RULES) {
    let n = rule.count(text);
    // 规则可声明 allow()，按文件扣掉已登记的例外（例如结构性自定义触发器）
    if (rule.allow) n = rule.allow(rel, n);
    if (n > 0) {
      const bucket = perRule.get(rule.id);
      bucket.total += n;
      bucket.byFile.set(rel, n);
    }
  }
}

const totals = Object.fromEntries(RULES.map((r) => [r.id, perRule.get(r.id).total]));

/* ---------------- 报告 ---------------- */

function printTable() {
  console.log(`\n扫描 ${files.length} 个源文件（src/**/*.ts|tsx）\n`);
  const rows = RULES.map((r) => ({
    规则: r.id,
    当前: totals[r.id],
    预算: baseline?.budgets?.[r.id] ?? '—',
    状态: baseline?.budgets?.[r.id] === undefined
      ? '新'
      : totals[r.id] > baseline.budgets[r.id]
        ? '超预算'
        : '通过',
  }));
  const width = Math.max(...rows.map((r) => String(r.规则).length), 8);
  console.log(
    `${'规则'.padEnd(width)}  ${'当前'.padStart(4)}  ${'预算'.padStart(4)}  状态`,
  );
  console.log('-'.repeat(width + 22));
  for (const r of rows) {
    console.log(
      `${String(r.规则).padEnd(width)}  ${String(r.当前).padStart(4)}  ${String(r.预算).padStart(4)}  ${r.状态}`,
    );
  }
}

const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : null;

printTable();

const regressions = RULES.filter((r) => {
  const budget = baseline?.budgets?.[r.id];
  return budget !== undefined && totals[r.id] > budget;
});

if (MODE_UPDATE) {
  const payload = {
    generatedAt: new Date().toISOString().slice(0, 10),
    note: 'UI 一致性预算。数值只允许下调：重构收敛后用 --update 重写，闸门会随之收紧。',
    budgets: totals,
  };
  writeFileSync(baselineFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`\n已写入预算：${relative(webRoot, baselineFile)}`);
  process.exit(0);
}

if (regressions.length) {
  console.error('\n以下指标超出预算：');
  for (const r of regressions) {
    console.error(`\n  ${r.id}  ${baseline.budgets[r.id]} → ${totals[r.id]}  （${r.title}）`);
    console.error(`    判据：${r.hint}`);
    const top = [...perRule.get(r.id).byFile.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [file, n] of top) console.error(`    ${String(n).padStart(4)}  ${file}`);
  }
  console.error('\n处理方式：把新增点改回既有类/令牌；确属合理的动态值，写进该文件的允许清单并说明理由。');
  process.exit(1);
}

if (MODE_REPORT) {
  console.log('\n只读模式：未失败。');
  process.exit(0);
}

console.log('\nUI 一致性校验通过：所有指标均未超出预算。');