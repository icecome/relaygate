'use strict';
/**
 * test/rtk.test.js —— RTK 工具输出压缩器（源 ESM → 本项目 CJS 移植）的契约测试。
 * 运行：node src/test/rtk.test.js
 *
 * 覆盖七条不可动摇的点：
 *   1. 字节账本不变量：bytesBefore - bytesAfter === saved === Σ hits[].saved。
 *      每个过滤器各有一份真实感输入（几百字节到几十 KB）。
 *   2. 确定性：同一输入连续两次压缩，输出与 stats 必须完全相同 —— 不同次输出不同
 *      会让上游 prompt cache 全丢，省下的 token 还没缓存损失多。
 *   3. 错误轨迹跳过：带 is_error 的 tool 消息一个字节都不变。
 *   4. 小 blob 不动：< 500 字节（UTF-8）的 tool 输出一个字节都不改。
 *   5. fail-open：过滤器抛错时请求照发、notes 记一条、函数不抛。
 *   6. 不缺不增：非 tool 消息与非 text 块逐字节不变，消息条数与顺序不变，
 *      且入参对象不被修改。
 *   7. 中文口径：saved 按 UTF-8 字节算，而不是 String.length —— 源实现就错在这里。
 */
const os = require('os');
const path = require('path');
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `rtk-test-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_KEY = 'test-admin-key';
require('./isolation-guard')('rtk');

const assert = require('assert');
const {
  compressMessages,
  compressToolOutput,
  autoDetectFilter,
  resolveFilter,
  allFilters,
  formatRtkLog,
  utf8Bytes,
  constants,
  FILTERS,
} = require('../lib/rtk');

const MIN = constants.MIN_COMPRESS_SIZE;

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      pass++;
      console.log(`  ok  ${name}`);
    } catch (e) {
      fail++;
      console.error(`FAIL  ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

/** 全模块唯一的体量口径：UTF-8 字节。 */
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const clone = (v) => JSON.parse(JSON.stringify(v));

/** 本项目形态的工具消息。 */
function toolMsg(text, id) {
  return { role: 'tool', tool_call_id: id || 'call_1', content: [{ type: 'text', text }] };
}

// ── 各过滤器的真实感输入 ─────────────────────────────────────────────────────

/** git diff：两个文件，其中一个 hunk 有 400 行新增（远超 100 行/hunk 的上限）。 */
function fixtureGitDiff() {
  const lines = [
    'diff --git a/src/lib/parse.js b/src/lib/parse.js',
    'index 1a2b3c4..5d6e7f8 100644',
    '--- a/src/lib/parse.js',
    '+++ b/src/lib/parse.js',
    '@@ -1,6 +1,400 @@',
    ' const fs = require("fs");',
    ' const path = require("path");',
  ];
  for (let i = 0; i < 400; i++) {
    lines.push(`+  const field${i} = readField(record, "field${i}");`);
  }
  lines.push('diff --git a/src/lib/render.js b/src/lib/render.js');
  lines.push('--- a/src/lib/render.js');
  lines.push('+++ b/src/lib/render.js');
  lines.push('@@ -10,3 +10,4 @@');
  lines.push(' const out = [];');
  lines.push('+out.push(header);');
  lines.push(' return out.join("\\n");');
  return lines.join('\n');
}

/** git status 长格式：24 个已修改 + 18 个未跟踪。 */
function fixtureGitStatus() {
  const lines = [
    'On branch main',
    "Your branch is up to date with 'origin/main'.",
    '',
    'Changes not staged for commit:',
    '  (use "git add <file>..." to update what will be committed)',
  ];
  for (let i = 0; i < 24; i++) lines.push(`\tmodified:   src/feature/module-${i}.js`);
  lines.push('', 'Untracked files:', '  (use "git add <file>..." to include in what will be committed)');
  for (let i = 0; i < 18; i++) lines.push(`\tscratch/tmp-${i}.txt`);
  return lines.join('\n');
}

/** git log 默认格式：40 条 commit，各带作者、日期和三行正文散文。 */
function fixtureGitLog() {
  const out = [];
  for (let i = 0; i < 40; i++) {
    const sha = `a1b2c3d${i.toString(16).padStart(4, '0')}`;
    out.push(`commit ${sha}`);
    out.push('Author: Dev <dev@example.com>');
    out.push('Date:   Mon Jan 1 12:00:00 2024 +0800');
    out.push('');
    out.push(`    feat: change number ${i} in the parser`);
    out.push('');
    out.push('    This body explains why in a few sentences, and it is prose the');
    out.push('    model does not need. There are forty of these blocks in the log.');
    out.push('');
  }
  return out.join('\n');
}

/** grep -rn：3 个文件各 14 条命中。 */
function fixtureGrep() {
  const out = [];
  for (const file of ['src/lib/a.js', 'src/lib/b.js', 'src/routes/c.js']) {
    for (let i = 1; i <= 14; i++) out.push(`${file}:${i * 7}:  const value${i} = compute(record, ${i});`);
  }
  return out.join('\n');
}

/** find：两个目录共 42 个路径。 */
function fixtureFind() {
  const out = [];
  for (let i = 0; i < 30; i++) out.push(`./src/components/widget-${i}.jsx`);
  for (let i = 0; i < 12; i++) out.push(`./src/hooks/use-thing-${i}.ts`);
  return out.join('\n');
}

/** ls -la：2 个目录（其中一个是 node_modules 噪声）+ 26 个文件 + 1 个软链。 */
function fixtureLs() {
  const rows = ['total 480', 'drwxr-xr-x  6 bing  staff   192 Jan 12 09:14 src', 'drwxr-xr-x 12 bing  staff   384 Jan 12 09:14 node_modules'];
  for (let i = 0; i < 26; i++) {
    rows.push(`-rw-r--r--  1 bing  staff  ${1200 + i * 37} Jan 12 09:14 module-${i}.js`);
  }
  rows.push('lrwxrwxrwx  1 bing  staff     9 Jan 12 09:14 latest -> module-0.js');
  return rows.join('\n');
}

/** tree：261 行（超过 200 行上限），末尾带 "N directories, M files" 摘要。 */
function fixtureTree() {
  const rows = ['.', '├── src'];
  for (let i = 0; i < 260; i++) rows.push(`│   ├── file-${i}.js`);
  rows.push('└── package.json', '', '3 directories, 261 files');
  return rows.join('\n');
}

/** npm + cargo 混合构建日志：60 条弃用、40 条 Compiling、一段 rustc 错误、摘要。 */
function fixtureBuild() {
  const out = ['> project@1.0.0 build', '> tsc -p tsconfig.build.json', ''];
  for (let i = 0; i < 60; i++) out.push(`npm warn deprecated legacy-pkg-${i}@1.0.${i}: use new-pkg instead`);
  for (let i = 0; i < 40; i++) out.push(`Compiling crate-${i} v0.1.${i}`);
  out.push('error[E0308]: mismatched types');
  out.push(' --> src/lib/parse.js:31:9');
  out.push('  |');
  out.push('31 |   const x = readField(record);');
  out.push('  |           ^^^^^^^^^ expected `string`, found `number`');
  out.push('  = note: expected type `string`');
  out.push('  = note: found type `number`');
  out.push('warning: unused variable: `tmp`');
  out.push('added 120 packages, and audited 121 packages in 3s');
  out.push('12 packages are looking for funding');
  return out.join('\n');
}

/** 重复行日志：3 段各 100 行完全相同的行（没有冒号，不会被 grep/find 抢走）。 */
function fixtureDedup() {
  const msgs = [
    '[INFO] waiting for the shared lock',
    '[INFO] retrying after 200ms backoff',
    '[WARN] slow query observed, still waiting',
  ];
  const out = [];
  for (const m of msgs) {
    for (let i = 0; i < 100; i++) out.push(m);
  }
  return out.join('\n');
}

/**
 * 编号转储（稠密短行）：能被**自动检测**选中的那一种。
 *
 * 注意这里的行必须极短：源实现的 read-numbered 判定要求「前 1024 个字符里就有
 * ≥250 行」（DETECT_WINDOW 切成的前缀里 `lines.length >= 250`）。这是源实现的几何
 * 约束，移植时**原样保留**，没有顺手放宽 —— 放宽它会改变哪些 blob 被压，属于行为
 * 变更而不是修 bug。
 */
function fixtureReadNumberedDense() {
  const out = [];
  for (let i = 0; i < 300; i++) out.push(`${(i % 99) + 1}|`);
  return out.join('\n');
}

/** 编号转储（真实感长行）：只能**显式指定**过滤器，自动检测在这个尺寸下够不到 250 行。 */
function fixtureReadNumberedRealistic() {
  const out = [];
  for (let i = 0; i < 300; i++) out.push(`  ${i + 1}|const field${i} = readField(record, ${i});`);
  return out.join('\n');
}

/** Cursor Glob 结果清单：一个头 + 43 条 `- path`。 */
function fixtureSearchList() {
  const out = ["Result of search in 'src/**/*.js' (total 43 files):"];
  for (let i = 0; i < 25; i++) out.push(`- src/lib/mod-${i}.js`);
  for (let i = 0; i < 18; i++) out.push(`- src/routes/route-${i}.js`);
  return out.join('\n');
}

/** 无结构大 blob：300 行、其中只有 3 行有内容（其余是制表符填充，但体量过闸门）。 */
function fixtureSmartTruncate() {
  const out = [];
  for (let i = 0; i < 300; i++) {
    if (i === 5) out.push('bootstrap starting the long running task');
    else if (i === 150) out.push('heartbeat');
    else if (i === 295) out.push('done');
    else out.push('\t\t');
  }
  return out.join('\n');
}

/** 中文 grep 结果：2 个文件各 16 条命中，用于验证 UTF-8 字节口径。 */
function fixtureChineseGrep() {
  const out = [];
  for (const file of ['src/中文模块/解析.js', 'src/中文模块/渲染.js']) {
    for (let i = 1; i <= 16; i++) {
      out.push(`${file}:${i * 3}:  这是第 ${i} 条中文匹配内容，用来验证字节口径`);
    }
  }
  return out.join('\n');
}

const FIXTURES = [
  { name: 'git diff', filter: FILTERS.GIT_DIFF, text: fixtureGitDiff() },
  { name: 'git status（长格式）', filter: FILTERS.GIT_STATUS, text: fixtureGitStatus() },
  { name: 'git log', filter: FILTERS.GIT_LOG, text: fixtureGitLog() },
  { name: 'grep -rn', filter: FILTERS.GREP, text: fixtureGrep() },
  { name: 'find', filter: FILTERS.FIND, text: fixtureFind() },
  { name: 'ls -la', filter: FILTERS.LS, text: fixtureLs() },
  { name: 'tree', filter: FILTERS.TREE, text: fixtureTree() },
  { name: 'npm/cargo 构建日志', filter: FILTERS.BUILD_OUTPUT, text: fixtureBuild() },
  { name: '重复行日志', filter: FILTERS.DEDUP_LOG, text: fixtureDedup() },
  { name: '编号转储（稠密短行，自动检测）', filter: FILTERS.READ_NUMBERED, text: fixtureReadNumberedDense() },
  { name: '编号转储（真实感长行，显式指定）', filter: FILTERS.READ_NUMBERED, text: fixtureReadNumberedRealistic(), explicit: true },
  { name: '搜索清单（Cursor Glob）', filter: FILTERS.SEARCH_LIST, text: fixtureSearchList() },
  { name: '无结构大 blob', filter: FILTERS.SMART_TRUNCATE, text: fixtureSmartTruncate() },
];

/** 显式指定过滤器时走 resolve 钩子（compressMessages 不认识单个 filter 名）。 */
function optsFor(f) {
  return f.explicit ? { resolve: () => resolveFilter(f.filter) } : undefined;
}
function ctxFor(f) {
  return f.explicit ? { filter: f.filter } : {};
}

// ── 1. 字节账本不变量 ────────────────────────────────────────────────────────

console.log('1. 字节账本不变量（每个过滤器各一份真实感输入）');

for (const f of FIXTURES) {
  t(`${f.name}：bytesBefore - bytesAfter === saved === Σ hits[].saved`, () => {
    const prim = compressToolOutput(f.text, ctxFor(f));
    assert.strictEqual(prim.filter, f.filter, `应命中 ${f.filter}，实际 ${prim.filter}`);
    assert.notStrictEqual(prim.text, f.text, '必须真的压缩了');
    assert.ok(prim.saved > 0, 'saved 必须为正');
    assert.strictEqual(prim.saved, bytes(f.text) - bytes(prim.text), 'saved 必须是 UTF-8 字节差');
    assert.strictEqual(prim.note, undefined, '正常路径不该有 note');

    const r = compressMessages([toolMsg(f.text, 'c1')], optsFor(f));
    assert.strictEqual(r.stats.bytesBefore, bytes(f.text));
    assert.strictEqual(r.stats.bytesAfter, bytes(prim.text));
    assert.strictEqual(r.stats.bytesBefore - r.stats.bytesAfter, r.stats.saved, '账本必须自洽');
    assert.strictEqual(r.stats.saved, prim.saved, 'saved 必须等于 Σ hits[].saved（此处仅一个 blob）');
    assert.strictEqual(r.stats.saved, bytes(f.text) - bytes(r.messages[0].content[0].text));
    assert.strictEqual(r.stats.blocks, 1);
    assert.strictEqual(r.stats.calls, 1, '检查过 1 个 blob（命中）');
    assert.deepStrictEqual(r.stats.filters, [f.filter]);
    assert.deepStrictEqual(r.stats.notes, []);
  });
}

t('多 blob：saved 等于每个 blob 原语 saved 之和，calls 含未命中、filters 去重', () => {
  const diff = fixtureGitDiff();
  const status = fixtureGitStatus();
  const tiny = '小输出：一个字节都不该改。';
  const msgs = [toolMsg(diff, 'c1'), toolMsg(status, 'c2'), toolMsg(tiny, 'c3')];
  const { messages, stats } = compressMessages(msgs);

  const expected =
    compressToolOutput(diff).saved + compressToolOutput(status).saved + compressToolOutput(tiny).saved;
  assert.strictEqual(stats.saved, expected);
  assert.strictEqual(stats.bytesBefore - stats.bytesAfter, stats.saved);
  assert.strictEqual(stats.calls, 3, 'calls 必须含未命中的 blob（否则有效率分母失真）');
  assert.strictEqual(stats.blocks, 2);
  assert.deepStrictEqual(stats.filters, [FILTERS.GIT_DIFF, FILTERS.GIT_STATUS]);
  assert.strictEqual(stats.bytesBefore, bytes(diff) + bytes(status) + bytes(tiny));
  assert.strictEqual(
    stats.bytesAfter,
    bytes(messages[0].content[0].text) + bytes(messages[1].content[0].text) + bytes(tiny),
  );
});

t('小 blob 不改动也不产生 hit，但计入 bytesBefore / calls', () => {
  // 不足 500 字节：marker 会比它替换掉的内容还长。
  const small = 'file.js:12:    const x = 1;\n'.repeat(10);
  assert.ok(bytes(small) < MIN, `fixture 必须小于 ${MIN} 字节，实际 ${bytes(small)}`);
  const { messages, stats } = compressMessages([toolMsg(small, 'c1')]);
  assert.strictEqual(messages[0].content[0].text, small);
  assert.strictEqual(stats.saved, 0);
  assert.strictEqual(stats.blocks, 0);
  assert.strictEqual(stats.calls, 1);
  assert.strictEqual(stats.bytesBefore, bytes(small));
  assert.strictEqual(stats.bytesAfter, bytes(small));
});

t('认不出的 blob 原样放过（错误的压缩比不压缩更糟）', () => {
  const line = '这段说明反复出现，只是为了把体量推过闸门。';
  const prose = [line.repeat(5), `${line.repeat(3)}结束。`, line.repeat(5)].join('\n');
  assert.ok(bytes(prose) >= MIN, 'fixture 必须过体量闸门');
  assert.strictEqual(autoDetectFilter(prose), null);
  const prim = compressToolOutput(prose);
  assert.strictEqual(prim.filter, null);
  assert.strictEqual(prim.text, prose);
  assert.strictEqual(prim.saved, 0);
});

t('registry：别名 rg/fd 指向同一实现；build-output 刻意不在注册表里', () => {
  assert.strictEqual(resolveFilter('rg').filterName, 'grep');
  assert.strictEqual(resolveFilter('fd').filterName, 'find');
  assert.strictEqual(resolveFilter('git-diff'), allFilters()['git-diff']);
  assert.strictEqual(resolveFilter('build-output'), null);
  assert.strictEqual(resolveFilter('nope'), null);
  assert.strictEqual(Object.keys(allFilters()).length, 11);
});

// ── 2. 确定性 ────────────────────────────────────────────────────────────────

console.log('2. 确定性（cache 前缀不得失效）');

t('同一输入连续两次压缩，输出与 stats 完全相同', () => {
  for (const f of FIXTURES) {
    const a = compressMessages([toolMsg(f.text, 'c1')], optsFor(f));
    const b = compressMessages([toolMsg(f.text, 'c1')], optsFor(f));
    assert.deepStrictEqual(b.messages, a.messages, `${f.name}: 输出必须逐字节稳定`);
    assert.deepStrictEqual(b.stats, a.stats, `${f.name}: stats 必须稳定`);

    const p1 = compressToolOutput(f.text, ctxFor(f));
    const p2 = compressToolOutput(f.text, ctxFor(f));
    assert.deepStrictEqual(p2, p1, `${f.name}: 原语输出必须稳定`);
  }
});

t('混排（多过滤器 + 未命中）两次压缩输出相同', () => {
  const msgs = [
    { role: 'system', content: '你是助手' },
    toolMsg(fixtureGrep(), 'c1'),
    { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: fixtureTree() }] },
    toolMsg('短', 'c3'),
  ];
  const a = compressMessages(clone(msgs));
  const b = compressMessages(clone(msgs));
  assert.deepStrictEqual(b, a);
});

// ── 3. 错误轨迹跳过 ──────────────────────────────────────────────────────────

console.log('3. 错误轨迹必须跳过');

t('is_error 的 tool 消息逐字节不变，且不产生任何 hit / 计数', () => {
  const diff = fixtureGitDiff();
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: diff }], is_error: true },
  ];
  const snapshot = JSON.stringify(msgs);
  const { messages, stats } = compressMessages(msgs);

  assert.strictEqual(messages[1].content[0].text, diff, '错误输出的字节数必须完全不变');
  assert.strictEqual(messages[1], msgs[1], '错误消息应原引用返回');
  assert.strictEqual(JSON.stringify(msgs), snapshot);
  assert.strictEqual(stats.saved, 0);
  assert.strictEqual(stats.blocks, 0);
  assert.strictEqual(stats.calls, 0, '跳过的错误轨迹不该计入 calls');
  assert.strictEqual(stats.bytesBefore, 0);
  assert.deepStrictEqual(stats.filters, []);
  assert.deepStrictEqual(stats.notes, []);
});

t('同一批里正常结果照压、错误结果照留', () => {
  const diff = fixtureGitDiff();
  const msgs = [
    { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: diff }] },
    { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: diff }], is_error: true },
  ];
  const { messages, stats } = compressMessages(msgs);
  assert.ok(messages[0].content[0].text.length < diff.length, '正常结果必须被压缩');
  assert.strictEqual(messages[1].content[0].text, diff, '错误结果必须逐字节保留');
  assert.strictEqual(stats.blocks, 1);
  assert.strictEqual(stats.calls, 1);
});

// ── 4. 小 blob 不动 ──────────────────────────────────────────────────────────

console.log('4. 小 blob 不动');

t('< 500 字节的多种工具输出一个字节都不改', () => {
  const smalls = [
    'diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-old\n+new\n',
    'a.js\nb.js\nc.js\n',
    'a.js:1:x\na.js:2:y\n',
    'On branch main\nnothing to commit, working tree clean\n',
    'x'.repeat(MIN - 1),
  ];
  for (const s of smalls) {
    assert.ok(bytes(s) < MIN, `fixture 必须 < ${MIN}：${bytes(s)}`);
    const { messages, stats } = compressMessages([toolMsg(s, 'c1')]);
    assert.strictEqual(messages[0].content[0].text, s, '小 blob 必须逐字节不变');
    assert.strictEqual(stats.saved, 0);
    assert.strictEqual(stats.bytesBefore, bytes(s));
  }
  // 闸门是「小于」：正好 500 字节的输入允许进入压缩路径。
  const atGate = `${'a.js:1:placeholder content that pads the line\n'.repeat(12)}`;
  assert.ok(bytes(atGate) >= MIN, `需要 >= ${MIN} 字节，实际 ${bytes(atGate)}`);
  assert.notStrictEqual(compressToolOutput(atGate).text, atGate, '过闸门的输入应被压缩');
});

// ── 5. fail-open ─────────────────────────────────────────────────────────────

console.log('5. fail-open：过滤器抛错不得让请求失败');

function throwingFilter() {
  throw new Error('boom: 注入的坏过滤器');
}
throwingFilter.filterName = 'injected-boom';

function nonStringFilter() {
  return undefined; // 漏了返回值的过滤器
}
nonStringFilter.filterName = 'injected-undefined';

t('过滤器抛错 → 原样保留 + 抛错信息进 notes + 函数不抛', () => {
  const diff = fixtureGitDiff();
  const notes = [];
  const prim = compressToolOutput(diff, { resolve: () => throwingFilter, notes });
  assert.strictEqual(prim.text, diff, '抛错必须退化成原样返回');
  assert.strictEqual(prim.saved, 0);
  assert.strictEqual(prim.filter, null);
  assert.ok(prim.note && prim.note.includes('injected-boom'), 'note 必须点名坏过滤器');
  assert.strictEqual(notes.length, 1);

  const messages = [toolMsg(diff, 'c1')];
  let result;
  assert.doesNotThrow(() => {
    result = compressMessages(messages, { resolve: () => throwingFilter });
  }, '压缩失败绝不能让整个请求失败');
  assert.strictEqual(result.messages[0].content[0].text, diff, '消息仍可读（原样）');
  assert.strictEqual(result.stats.notes.length, 1, 'notes 里必须有一条');
  assert.strictEqual(result.stats.saved, 0);
  assert.strictEqual(result.stats.blocks, 0);
  assert.ok(result.stats.bytesBefore >= bytes(diff));
});

t('过滤器返回非字符串 → 同样 fail-open，并记一条 note', () => {
  const diff = fixtureGitDiff();
  const { messages, stats } = compressMessages([toolMsg(diff, 'c1')], { resolve: () => nonStringFilter });
  assert.strictEqual(messages[0].content[0].text, diff);
  assert.strictEqual(stats.notes.length, 1);
  assert.strictEqual(stats.saved, 0);
});

t('坏过滤器只影响它自己那一份 blob，同批其它 blob 照压', () => {
  const diff = fixtureGitDiff();
  const status = fixtureGitStatus();
  let n = 0;
  const { messages, stats } = compressMessages(
    [toolMsg(diff, 'c1'), toolMsg(status, 'c2')],
    { resolve: () => (n++ === 0 ? throwingFilter : autoDetectFilter(status)) },
  );
  assert.strictEqual(messages[0].content[0].text, diff, '抛错的 blob 原样保留');
  assert.ok(messages[1].content[0].text.length < status.length, '另一个 blob 仍应被压缩');
  assert.strictEqual(stats.notes.length, 1);
  assert.strictEqual(stats.blocks, 1);
  assert.strictEqual(stats.bytesBefore - stats.bytesAfter, stats.saved);
});

// ── 6. 不缺不增 ──────────────────────────────────────────────────────────────

console.log('6. 不缺不增：非 tool 消息与非 text 块逐字节不变，入参不被修改');

t('混合消息：条数、顺序、非 tool 内容、非 text 块全部不变', () => {
  const diff = fixtureGitDiff();
  const msgs = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: [{ type: 'text', text: '看看改动' }] },
    {
      role: 'assistant',
      content: [{ type: 'text', text: '好的' }],
      tool_calls: [{ id: 'c1', function: { name: 'git_diff', arguments: '{}' } }],
    },
    toolMsg(diff, 'c1'),
    { role: 'tool', tool_call_id: 'c2', content: [{ type: 'image', source: { data: 'AAAA' } }, { type: 'text', text: '看到图了吗' }] },
    { role: 'user', content: '结束' },
  ];
  const snapshot = JSON.stringify(msgs);
  const { messages, stats } = compressMessages(msgs);

  assert.strictEqual(JSON.stringify(msgs), snapshot, '入参对象不得被修改');
  assert.strictEqual(messages.length, msgs.length, '消息条数不变');
  assert.deepStrictEqual(messages.map((m) => m.role), msgs.map((m) => m.role), '消息顺序不变');

  // 未被压缩的条目保持同一引用（既没换对象也没动字段）
  assert.strictEqual(messages[0], msgs[0]);
  assert.strictEqual(messages[1], msgs[1]);
  assert.strictEqual(messages[2], msgs[2]);
  assert.strictEqual(messages[5], msgs[5]);

  // 非 text 块逐字节不变
  assert.deepStrictEqual(messages[4].content[0], msgs[4].content[0]);
  assert.strictEqual(messages[4].content[1].text, '看到图了吗');

  // 被压缩的 tool 消息是新对象，但其它字段与块类型保留
  assert.notStrictEqual(messages[3], msgs[3]);
  assert.strictEqual(messages[3].tool_call_id, 'c1');
  assert.strictEqual(messages[3].content[0].type, 'text');
  assert.ok(messages[3].content[0].text.length < diff.length);
  assert.deepStrictEqual(msgs[3].content[0].text, diff, '原消息对象的 text 不得被就地改写');

  assert.ok(stats.saved > 0);
  assert.strictEqual(stats.calls, 2, '只有两个 tool text 块进入检查');
});

t('本项目形态之外的消息形态一律放过（只保留一条 walker）', () => {
  const diff = fixtureGitDiff();
  const msgs = [
    // Anthropic 原生 tool_result 形态：本项目不走这条 walker
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: diff }] },
    // 源实现的形态 1：content 是字符串的 tool 消息
    { role: 'tool', tool_call_id: 'c2', content: diff },
    // content 不是数组
    { role: 'tool', tool_call_id: 'c3', content: null },
    // text 块里 text 不是字符串
    { role: 'tool', tool_call_id: 'c4', content: [{ type: 'text', text: 42 }] },
  ];
  const snapshot = JSON.stringify(msgs);
  const { messages, stats } = compressMessages(msgs);

  assert.strictEqual(JSON.stringify(messages), snapshot, '这些形态必须逐字节不变');
  assert.strictEqual(stats.saved, 0);
  assert.strictEqual(stats.calls, 0, '没走 walker 的形态不计入 calls');
  assert.deepStrictEqual(stats.notes, []);
});

t('enabled=false 与空 messages：原样返回、stats 全 0', () => {
  const zeros = { bytesBefore: 0, bytesAfter: 0, saved: 0, blocks: 0, calls: 0, filters: [], notes: [] };
  const msgs = [toolMsg(fixtureGitDiff(), 'c1')];

  const off = compressMessages(msgs, { enabled: false });
  assert.strictEqual(off.messages, msgs, '关闭时必须原样返回（同一引用）');
  assert.deepStrictEqual(off.stats, zeros);
  assert.deepStrictEqual(compressMessages(msgs, false).stats, zeros, 'opts 传 false 同样关闭');

  const empty = compressMessages([]);
  assert.strictEqual(empty.messages.length, 0);
  assert.deepStrictEqual(empty.stats, zeros);

  const notArray = compressMessages(null);
  assert.deepStrictEqual(notArray.stats, zeros);
});

t('formatRtkLog：没有压缩时返回 null，有压缩时给出真实字节数', () => {
  assert.strictEqual(formatRtkLog(null), null);
  assert.strictEqual(formatRtkLog(compressMessages([toolMsg('短', 'c1')]).stats), null);

  const diff = fixtureGitDiff();
  const { stats } = compressMessages([toolMsg(diff, 'c1')]);
  const line = formatRtkLog(stats);
  assert.ok(line.includes(`${stats.saved}B`), '日志行里的字节数必须是真实 UTF-8 字节数');
  assert.ok(line.includes('git-diff'));
});

// ── 7. 中文口径 ──────────────────────────────────────────────────────────────

console.log('7. 中文口径：saved 必须是 UTF-8 字节');

t('中文 grep：saved 按 Buffer.byteLength 算，而不是 String.length', () => {
  const text = fixtureChineseGrep();
  assert.ok(bytes(text) >= MIN);
  const prim = compressToolOutput(text, {});
  assert.strictEqual(prim.filter, 'grep', '中文 grep 结果同样必须被认出来');

  const utf8Delta = bytes(text) - bytes(prim.text);
  const utf16Delta = text.length - prim.text.length; // 源实现报的是这个数
  assert.strictEqual(prim.saved, utf8Delta, 'saved 必须是 UTF-8 字节差');
  assert.notStrictEqual(prim.saved, utf16Delta, 'UTF-8 口径必须与 String.length 口径不同');
  assert.ok(prim.saved > utf16Delta * 1.5, `中文下字节差应显著大于码元差（${prim.saved} vs ${utf16Delta}）`);

  const { stats } = compressMessages([toolMsg(text, 'c1')]);
  assert.strictEqual(stats.saved, prim.saved);
  assert.strictEqual(stats.bytesBefore - stats.bytesAfter, stats.saved);
  assert.strictEqual(stats.bytesBefore, bytes(text));
  assert.ok(stats.bytesBefore > text.length, 'bytesBefore 必须是字节而不是码元');
});

t('中文小 blob（< 500 字节）按字节闸门放行前先被挡住', () => {
  const cn = '中文字符测试。'.repeat(8); // 56 字符 ≈ 168 字节
  assert.ok(cn.length < MIN && bytes(cn) < MIN);
  const { messages } = compressMessages([toolMsg(cn, 'c1')]);
  assert.strictEqual(messages[0].content[0].text, cn);
});

t('utf8Bytes 导出与 Buffer.byteLength 同口径', () => {
  assert.strictEqual(utf8Bytes('中文abc'), Buffer.byteLength('中文abc', 'utf8'));
  assert.strictEqual(utf8Bytes(''), 0);
});

// ── 汇总 ─────────────────────────────────────────────────────────────────────

async function main() {
  await runAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(
      '\n任一失败项都意味着压缩契约与源实现不符：账本不成立会让「省了多少」变成假数，\n' +
      '输出不稳定会让上游 prompt cache 全丢，错误轨迹被压会让模型重试同一次失败调用。',
    );
  }
  if (process.exitCode) process.exit(process.exitCode);
}

main();
