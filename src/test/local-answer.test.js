'use strict';
/**
 * test/local-answer.test.js——本地应答检测器（五类固定提问的本地作答）。
 * 运行：node src/test/local-answer.test.js
 *
 * 不止测「命中」，更要钉住四件**源实现保真**的事：
 *   1. 求值顺序（`OPTIMIZATIONS`）不可换——quota 是「一个整数 + 一次子串判断」，
 *      必须排在要解析命令行的检测器前面先短路；
 *   2. 未命中一律返回 null，让调用方照常转发上游（本地应答是优化，不能吞掉转发）；
 *   3. **返回值里没有 `usage`**——源实现在每个检测器里塞了假 token 常量，本项目
 *      明确拒绝（假 token 会污染 `models/pricing-calib.js` 那条从 traffic 日志取样的
 *      标定回归）。这条是防回归断言；
 *   4. **绝不抛错**——畸形/敌意请求体只能换来 null，不能换来一个 500。
 *
 * 必须在 require 任何模块之前设置 WORKSPACE_DIR / TRAE_API_ENCRYPT_KEY，
 * 否则 config.workspaceDir 会固化到默认 output/，污染真实账号库。
 */
const os = require('os');
const path = require('path');
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `local-answer-test-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_KEY = 'test-admin-key';
require('./isolation-guard')('local-answer');

const assert = require('assert');
const {
  detectLocalAnswer,
  OPTIMIZATIONS,
  detectOptimization,
  extractCommandPrefix,
  extractFilepathsFromCommand,
} = require('../lib/local-answer');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) {
  queue.push({ name, fn });
}

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

// ---- 构造器：最小但**真实**的 Claude Code 形态请求 ----
// messages[].content 一律用 block 数组（真实客户端就是这么发的），Command: 所在的
// 块结构必须原样保留，不能被任何归一化形态替换。

/** 额度探针：max_tokens 1 + 唯一一轮 user 在问额度。 */
const reqQuota = () => ({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1,
  system: [{ type: 'text', text: 'You are Claude Code, Anthropic\u2019s official CLI.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Are we out of quota right now? Answer yes or no.' }] }],
});

/** 权限前缀提问：policy spec + `Command:` 段。 */
const reqPrefix = () => ({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 4096,
  messages: [{
    role: 'user',
    content: [{
      type: 'text',
      text: '<policy_spec>\nBash(git status:*)\nBash(git diff:*)\n</policy_spec>\n\nCommand: git status --short',
    }],
  }],
});

/** 会话标题提问：system 里带 sentence-case 要求，且从不带 tools。 */
const reqTitle = () => ({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 100,
  system: [{
    type: 'text',
    text: 'Generate a concise, sentence-case title (max 6 words) that captures the main topic of this coding session.',
  }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'user: 修一下登录页的 401 跳转' }] }],
});

/** suggestion 模式那一轮：答案就是「没有建议」。 */
const reqSuggestion = () => ({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{
    role: 'user',
    content: [{ type: 'text', text: '[SUGGESTION MODE: 1 suggestion ahead]\nThe user just pressed tab. Offer one next step.' }],
  }],
});

/** 文件路径提取：`Command:`/`Output:` 对，路径提示在 system 里。 */
const reqFilepath = () => ({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 200,
  system: [{ type: 'text', text: 'Extract any file paths that this command reads or writes, one per line.' }],
  messages: [{
    role: 'user',
    content: [{ type: 'text', text: 'Command: cat a.js b.js\nOutput: console.log(1)' }],
  }],
});

const fp = (...paths) => `<filepaths>\n${paths.join('\n')}\n</filepaths>`;
const EMPTY_FP = '<filepaths>\n</filepaths>';

// ---- 1. 五类各一条命中 ----

console.log('五类命中');

t('quota：max_tokens=1 + 唯一 user 轮提到 quota', () => {
  const r = detectLocalAnswer(reqQuota());
  assert.ok(r, '应命中');
  assert.strictEqual(r.kind, 'quota');
  assert.strictEqual(r.text, 'Quota check passed.');
  assert.strictEqual(r.stopReason, 'end_turn');
});

t("quota：max_tokens 写成字符串 '1' 也命中（Python 侧会强制转换，两种拼写都收）", () => {
  const req = reqQuota();
  req.max_tokens = '1';
  assert.strictEqual(detectLocalAnswer(req).kind, 'quota');
});

t('prefix：policy spec + Command: → 前缀是双词命令 git status', () => {
  const r = detectLocalAnswer(reqPrefix());
  assert.ok(r, '应命中');
  assert.strictEqual(r.kind, 'prefix');
  assert.strictEqual(r.text, 'git status');
});

t('prefix：最后一个 Command: 胜出（policy spec 里引用过这个词也干扰不了）', () => {
  const req = reqPrefix();
  req.messages[0].content[0].text = '<policy_spec>\nCommand: is what follows the policy spec\n</policy_spec>\nCommand: npm run build --silent';
  assert.strictEqual(detectLocalAnswer(req).text, 'npm run', 'npm 是双词命令表里的，第三个词不进前缀');
});

t('title：system 要求 sentence-case title → 定值 Conversation', () => {
  const r = detectLocalAnswer(reqTitle());
  assert.ok(r, '应命中');
  assert.strictEqual(r.kind, 'title');
  assert.strictEqual(r.text, 'Conversation');
});

t('title：system 走 JSON 字段分支也命中（return json + field + coding session）', () => {
  const req = reqTitle();
  req.system = [{ type: 'text', text: 'Return JSON with a "title" field describing this session. This session is a coding session.' }];
  const r = detectLocalAnswer(req);
  assert.ok(r, '应命中');
  assert.strictEqual(r.kind, 'title');
});

t('title：system 是**字符串**（不是 block 数组）同样命中', () => {
  const req = reqTitle();
  req.system = 'Generate a concise, sentence-case title for this conversation.';
  assert.strictEqual(detectLocalAnswer(req).kind, 'title');
});

t('suggestion：[SUGGESTION MODE: 标记 → 空正文（源语义：正确答案是「无建议」）', () => {
  const r = detectLocalAnswer(reqSuggestion());
  assert.ok(r, '应命中');
  assert.strictEqual(r.kind, 'suggestion');
  assert.strictEqual(typeof r.text, 'string');
  assert.strictEqual(r.text, '', '源实现就是空正文，改成任何文案都是偏离源语义');
});

t('filepath：Command:/Output: + system 要求提取路径 → filepaths 块', () => {
  const r = detectLocalAnswer(reqFilepath());
  assert.ok(r, '应命中');
  assert.strictEqual(r.kind, 'filepath');
  assert.strictEqual(r.text, fp('a.js', 'b.js'));
});

t('filepath：路径提示写在 user 里（提到 filepaths）也命中', () => {
  const req = reqFilepath();
  req.system = undefined;
  req.messages[0].content[0].text = 'Command: grep -e TODO src\nOutput: src/a.js:3:TODO\nList the filepaths this command reads.';
  const r = detectLocalAnswer(req);
  assert.ok(r, '应命中');
  assert.strictEqual(r.kind, 'filepath');
  assert.strictEqual(r.text, fp('src'));
});

// ---- 2. 求值顺序 ----

console.log('求值顺序（不可换）');

t('OPTIMIZATIONS 常量就是导出契约里的那个顺序', () => {
  assert.deepStrictEqual(OPTIMIZATIONS, ['quota', 'prefix', 'title', 'suggestion', 'filepath']);
});

t('同时满足 quota 与 title → 返回 quota（省的那个先短路）', () => {
  const req = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1,
    system: [{ type: 'text', text: 'Generate a concise, sentence-case title for this conversation.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'quota?' }] }],
  };
  const r = detectLocalAnswer(req);
  assert.strictEqual(r.kind, 'quota');
  assert.strictEqual(r.text, 'Quota check passed.');
  assert.strictEqual(detectOptimization(req), 'quota');
});

t('同时满足 prefix 与 filepath → 返回 prefix', () => {
  const req = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4096,
    system: [{ type: 'text', text: 'Extract any file paths that this command reads or writes.' }],
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: '<policy_spec>\nBash(cat:*)\n</policy_spec>\nCommand: cat a.js b.js\nOutput: x\nlist the filepaths' }],
    }],
  };
  assert.strictEqual(detectLocalAnswer(req).kind, 'prefix');
});

t('同时满足 title 与 filepath → 返回 title', () => {
  const req = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 200,
    system: [{ type: 'text', text: 'Generate a sentence-case title. Also extract any file paths that this command reads or writes.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Command: cat a.js\nOutput: x\nfilepaths' }] }],
  };
  assert.strictEqual(detectLocalAnswer(req).kind, 'title');
});

t('enabled[kind] === false 时跳过该项优化', () => {
  const req = reqQuota();
  assert.strictEqual(detectLocalAnswer(req, { enabled: { quota: false } }), null, '关掉 quota 后其余四项都不匹配');
  assert.strictEqual(detectOptimization(req, { quota: false }), null);
  // 关掉 quota 后，同时满足 title 的请求应落到 title
  req.system = [{ type: 'text', text: 'Generate a concise, sentence-case title.' }];
  assert.strictEqual(detectLocalAnswer(req, { enabled: { quota: false } }).kind, 'title');
});

// ---- 3. 未命中必须返回 null ----

console.log('未命中 → null');

const misses = {
  '普通对话请求': { model: 'm', max_tokens: 1024, messages: [{ role: 'user', content: [{ type: 'text', text: '你好，帮我看看这段代码' }] }] },
  '带 tools 的普通请求': {
    model: 'm',
    max_tokens: 4096,
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: '读一下 a.js' }] }],
  },
  '多轮请求（两条 user 轮）': { model: 'm', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'again' }] },
  'assistant 轮一起出现': { model: 'm', max_tokens: 1024, messages: [{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'again' }] },
  'tools 为空数组且内容无关': { model: 'm', max_tokens: 1024, tools: [], messages: [{ role: 'user', content: 'hi' }] },
  'quota 字样但 max_tokens 不是 1': { model: 'm', max_tokens: 2, messages: [{ role: 'user', content: 'quota?' }] },
  'max_tokens=1 但没提 quota': { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hello' }] },
  'max_tokens=1 但有两轮 user': { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'quota?' }, { role: 'user', content: 'quota?' }] },
  'Command: 但没有 policy spec': { model: 'm', max_tokens: 4096, messages: [{ role: 'user', content: 'Command: git status' }] },
  'policy spec 但没有 Command:': { model: 'm', max_tokens: 4096, messages: [{ role: 'user', content: '<policy_spec>\nBash(ls:*)\n</policy_spec>' }] },
  'title 提示词但带 tools': {
    model: 'm',
    max_tokens: 100,
    tools: [{ name: 'Read' }],
    system: 'Generate a concise, sentence-case title for this conversation.',
    messages: [{ role: 'user', content: 'hi' }],
  },
  'system 只说 title 但没有 sentence-case / json 分支': {
    model: 'm',
    max_tokens: 100,
    system: 'You are a helpful title generator.', // 命中 'title' 但两个分支都不满足
    messages: [{ role: 'user', content: 'hi' }],
  },
  'filepath 提示但带 tools': {
    model: 'm',
    max_tokens: 200,
    tools: [{ name: 'Read' }],
    system: 'Extract any file paths that this command reads or writes.',
    messages: [{ role: 'user', content: 'Command: cat a.js\nOutput: x' }],
  },
  'Command:/Output: 但没有 filepaths 字样、system 也不要求': {
    model: 'm',
    max_tokens: 200,
    system: 'You are Claude Code.',
    messages: [{ role: 'user', content: 'Command: cat a.js\nOutput: x' }],
  },
  'suggestion 标记只出现在 assistant 消息里': {
    model: 'm',
    max_tokens: 100,
    messages: [{ role: 'assistant', content: '[SUGGESTION MODE: nope]' }],
  },
  'suggestion 标记是 system 消息': {
    model: 'm',
    max_tokens: 100,
    messages: [{ role: 'system', content: '[SUGGESTION MODE: nope]' }],
  },
  'content 是空 block 数组': { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: [] }] },
};

for (const [name, req] of Object.entries(misses)) {
  t(`不命中：${name}`, () => {
    assert.strictEqual(detectLocalAnswer(req), null);
    assert.strictEqual(detectOptimization(req), null);
  });
}

// ---- 4. 无假 usage（防回归：源实现就是错的） ----

console.log('无假 usage');

t('五类命中都没有 usage 字段，键集合恰好是 kind/text/stopReason', () => {
  const hits = [reqQuota(), reqPrefix(), reqTitle(), reqSuggestion(), reqFilepath()]
    .map((req) => detectLocalAnswer(req));
  assert.strictEqual(hits.filter(Boolean).length, 5, '五条都应命中');
  for (const r of hits) {
    assert.ok(!('usage' in r), `命中结果不得带 usage（kind=${r.kind}）`);
    assert.deepStrictEqual(Object.keys(r).sort(), ['kind', 'stopReason', 'text']);
    assert.ok(!JSON.stringify(r).includes('usage'), '序列化后也不得出现 usage');
    assert.ok(!/\d+\s*tokens?/.test(r.text), '正文里不得夹带 token 数字');
  }
  // 整包返回值的形状也不得出现任何 token 计数键
  for (const r of hits) {
    assert.notStrictEqual(r.usage, { input: 10, output: 5 });
  }
});

// ---- 5. 绝不抛错 ----

console.log('绝不抛错（畸形 / 敌意请求体 → null）');

const garbage = {
  'null': null,
  'undefined': undefined,
  '{}': {},
  '[]': [],
  '字符串': 'not-a-request',
  '数字': 42,
  "messages: 'not-an-array'": { messages: 'not-an-array' },
  'messages: 123': { messages: 123 },
  'messages: null': { messages: null },
  'messages 里是 null 元素': { max_tokens: 1, messages: [null, undefined, 7] },
  'content: 123': { max_tokens: 1, messages: [{ role: 'user', content: 123 }] },
  'content 是对象': { max_tokens: 1, messages: [{ role: 'user', content: { text: 'quota' } }] },
  'content 是嵌套数组': { max_tokens: 1, messages: [{ role: 'user', content: [[{ type: 'text', text: 'quota' }]] }] },
  'system: 123': { max_tokens: 1, system: 123, messages: [{ role: 'user', content: 'hi' }] },
  'tools: 字符串（非空即视为声明了 tools）': { max_tokens: 4096, tools: 'Read', messages: [{ role: 'user', content: 'hi' }] },
  'block 里 text 不是字符串': { max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'text', text: 42 }, { type: 'text' }] }] },
};

for (const [name, req] of Object.entries(garbage)) {
  t(`不抛错且返回 null：${name}`, () => {
    let r;
    assert.doesNotThrow(() => { r = detectLocalAnswer(req); });
    assert.strictEqual(r, null);
  });
}

t('messages 是 throwing getter → 全部检测器各自兜底，返回 null 不抛出', () => {
  const req = {
    model: 'm',
    get messages() { throw new Error('boom: messages'); },
  };
  let r;
  assert.doesNotThrow(() => { r = detectLocalAnswer(req); });
  assert.strictEqual(r, null);
  assert.doesNotThrow(() => detectOptimization(req));
  assert.strictEqual(detectOptimization(req), null);
});

t('某个检测器抛错不影响后面的检测器：max_tokens getter 抛错，title 仍命中', () => {
  const req = {
    model: 'm',
    get max_tokens() { throw new Error('boom: max_tokens'); },
    system: 'Generate a concise, sentence-case title for this conversation.',
    messages: [{ role: 'user', content: 'quota probe (quota 字样在这里，只是 max_tokens 读不出来)' }],
  };
  let r;
  assert.doesNotThrow(() => { r = detectLocalAnswer(req); });
  assert.ok(r, 'quota 检测器抛错后应继续试后面的检测器');
  assert.strictEqual(r.kind, 'title', '出错的那个检测器只算「自己没命中」，不能连坐');
});

t('超长/畸形 Command：非匹配外壳 → null', () => {
  const huge = `cat "${'a'.repeat(200000)}`;
  const req = { model: 'm', max_tokens: 200, messages: [{ role: 'user', content: `Command: ${huge}` }] };
  let r;
  assert.doesNotThrow(() => { r = detectLocalAnswer(req); });
  assert.strictEqual(r, null, '缺 Output:/filepaths 提示，不该命中');
});

t('超长/畸形 Command：匹配外壳 → 走源实现的回退而不是抛错', () => {
  // 引号不闭合：shellWords 抛错，prefix 检测器按「空白切分 + 去 env 前缀」回退。
  // 这是**源行为**（要求 2 不许改判定式），所以这里断言回退结果而不是 null。
  const unclosed = `cat "${'a'.repeat(200000)}`;
  const req1 = {
    model: 'm',
    max_tokens: 4096,
    messages: [{ role: 'user', content: ` <policy_spec>\nBash(cat:*)\n</policy_spec>\nCommand: ${unclosed}` }],
  };
  let r1;
  assert.doesNotThrow(() => { r1 = detectLocalAnswer(req1); });
  assert.strictEqual(r1.kind, 'prefix');
  assert.strictEqual(r1.text, 'cat', '未闭合引号 → 空白切分回退取首词');

  // 命令替换（反引号 / $( ）：报原因，不解析、不执行
  for (const cmd of ['echo `date`', 'echo $(date)']) {
    const req = {
      model: 'm',
      max_tokens: 4096,
      messages: [{ role: 'user', content: `<policy_spec>\nBash(echo:*)\n</policy_spec>\nCommand: ${cmd}` }],
    };
    assert.strictEqual(detectLocalAnswer(req).text, 'command_injection_detected');
  }
});

// ---- 6. 命令解析 ----

console.log('extractCommandPrefix — 权限前缀');

const prefixCases = [
  // 双词命令：第二个词是操作名
  ['git diff', 'git diff'],
  ['git diff --stat', 'git diff'],
  ['git commit -m "hello world"', 'git commit'],
  ['npm install', 'npm install'],
  ['docker compose up -d', 'docker compose'],
  // 第二词是 flag → 只取首词
  ['git --version', 'git'],
  ['npm --version', 'npm'],
  ['git', 'git'],
  // 单词命令（含纯 listing）
  ['ls -la', 'ls'],
  ['ls', 'ls'],
  ['cat a.js', 'cat'],
  ['rm -rf build', 'rm'],
  // 环境变量前缀：单词命令保留前缀，双词命令丢掉前缀（源实现的非对称行为）
  ['FOO=1 cmd', 'FOO=1 cmd'],
  ['FOO=1 ls -la', 'FOO=1 ls'],
  ['FOO=1 git status', 'git status'],
  ['A=1 B=2 npm test', 'npm test'],
  // sudo 不在 TWO_WORD_COMMANDS 表里 → 只答 sudo（照源表，不做 basename、不加特例）
  ['sudo ls -la', 'sudo'],
  ['/usr/bin/git status', '/usr/bin/git'],
  // Windows 路径：反斜杠在非空白/引号前是字面量，不能被 POSIX 读法吃掉
  ['type C:\\notes\\todo.md', 'type'],
  // 引号不闭合 → shlex 式回退：空白切分 + 去 env 前缀
  ['cat "a.js', 'cat'],
  ['FOO=1 cat "a.js', 'cat'],
  // 命令替换 → 报原因
  ['echo `date`', 'command_injection_detected'],
  ['echo $(date)', 'command_injection_detected'],
  // 空 / 只有 env 赋值
  ['', 'none'],
  ['   ', 'none'],
  ['FOO=1', 'none'],
  // 非字符串输入
  [null, 'none'],
  [123, 'none'],
  [undefined, 'none'],
];

for (const [input, expected] of prefixCases) {
  t(`前缀 ${JSON.stringify(input)} → ${expected}`, () => {
    assert.strictEqual(extractCommandPrefix(input), expected);
  });
}

console.log('extractFilepathsFromCommand — 读取路径');

const filepathCases = [
  // reading 命令：非 flag 参数就是路径
  ['cat a.js b.js', fp('a.js', 'b.js')],
  ['cat -n a.js', fp('a.js')],
  ['type C:\\notes\\todo.md', fp('C:\\notes\\todo.md')],
  ['/bin/cat a.js', fp('a.js')], // 取 basename 认命令
  ['FOO=1 cat a.js', fp('a.js')], // 先去 env 前缀
  ['cat', EMPTY_FP],
  // 注意：reading 分支只按「不以 - 开头」筛，不认 flag 的参数——`head -n 5 a.md` 里
  // 的 5 会被当成路径。这是**源行为**，不是待修的 bug（要求 2），所以照样钉住。
  ['head -n 5 a.md b.md', fp('5', 'a.md', 'b.md')],
  // listing 命令：只列名字，没有内容可指向
  ['ls', EMPTY_FP],
  ['ls -la /tmp', EMPTY_FP],
  ['find . -name "*.js"', EMPTY_FP],
  ['tree -L 2', EMPTY_FP],
  ['rm -rf build', EMPTY_FP],
  ['pwd', EMPTY_FP],
  // grep：pattern 不是路径
  ['grep -e pat file', fp('file')],
  ['grep pat a.js b.js', fp('a.js', 'b.js')],
  ['grep -rn pat .', fp('.')],
  ['grep -A 3 pat file', fp('file')],
  ['grep -m 2 -C 1 pat file', fp('file')],
  ['grep --regexp pat file', fp('file')],
  ['grep --regexp=pat file', fp('file')],
  ['grep -e pat', EMPTY_FP],
  // 既不是 listing/reading 也不是 grep
  ['docker ps', EMPTY_FP],
  ['echo hi', EMPTY_FP],
  // 空 / 畸形
  ['', EMPTY_FP],
  ['cat "a.js', EMPTY_FP],
  [null, EMPTY_FP],
  [undefined, EMPTY_FP],
];

for (const [input, expected] of filepathCases) {
  t(`路径 ${JSON.stringify(input)} → ${expected.replace(/\n/g, '\\n')}`, () => {
    assert.strictEqual(extractFilepathsFromCommand(input), expected);
  });
}

t('output 参数按源签名收下但从不参与判定', () => {
  assert.strictEqual(extractFilepathsFromCommand('cat a.js', 'a\nb\nc'), fp('a.js'));
  assert.strictEqual(extractFilepathsFromCommand('ls', 'whatever'), EMPTY_FP);
});

t('filepath 检测器会把 Output: 段截断在第一个标签/空行处（截断位置与 Python 侧一致）', () => {
  const req = reqFilepath();
  req.messages[0].content[0].text = 'Command: cat a.js\nOutput: console.log(1)\n\n<system-reminder>ignored</system-reminder>';
  // 截断只影响一个从不被读取的值，答案仍然只来自命令本身
  assert.strictEqual(detectLocalAnswer(req).text, fp('a.js'));
});

// ---- 汇总 ----

async function main() {
  await runAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(
      '\n任一失败项都意味着本地应答契约被破坏：顺序换了会让便宜检查失去短路意义，\n' +
      '假 usage 会污染账单标定回归，抛错会把一次优化变成一次请求失败。',
    );
  }
  if (process.exitCode) process.exit(process.exitCode);
}

main();
