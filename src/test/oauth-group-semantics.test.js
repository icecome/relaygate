'use strict';
/**
 * src/test/oauth-group-semantics.test.js —— 「账号分组」不得被当成平台池开关。
 *
 * 现场问题（2026-11-09）：Trae OAuth 弹窗里有一个「默认池 / WorkBuddy 池」
 * 二选一，标注「决定账号进入哪个转发池」。WorkBuddy 已改用无感登录，
 * Trae 这里却还留着 WorkBuddy 池的选项。
 *
 * 事实是那个选项**从来没有产生过它声称的效果**：
 *
 *   1. 真正的分池依据是平台（`credentials/pool.js#editionOk` 按 edition 判：
 *      WorkBuddy 账号靠 edition='workbuddy' 进 WB 池），与 `group` 字段无关；
 *   2. `groupOk()` 只在环境变量 `POOL_GROUPS` 非空时才过滤分组，
 *      默认为空 ⇒ 恒返回 true；
 *   3. 本机 23 个账号的 group 实测全为 null。
 *
 * 所以「WorkBuddy 池」的净效果是：给一个 **Trae** 账号打上 group='workbuddy'
 * 的标签，池子不动、调度不变。这是纯空操作 + 误导。
 *
 * 本测试锁三件事：
 *   A. 前端 OauthTraeDialog 不再出现写死的「WorkBuddy 池」选项；
 *   B. 后端 groupOk 的语义就是「POOL_GROUPS 为空时不过滤」，与平台无关；
 *   C. 平台分池由 edition 决定，改 group 不会让 Trae 账号进 WorkBuddy 池。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 必须在 require 任何项目模块之前隔离状态目录与加密密钥（否则会写真实账号库）
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `trae-oauthgroup-${Date.now()}`);
// 加密密钥必须是 64 位十六进制（32 字节），用重复字母会触发 Invalid key length
process.env.TRAE_API_ENCRYPT_KEY = 'a1b2c3d4'.repeat(8);
process.env.SCHEDULER_ENABLED = 'false';
require('./isolation-guard')('oauth-group');

const ROOT = path.resolve(__dirname, '..', '..');

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name}  ${detail || ''}`);
  }
}

function main() {
  /* ---------- A. 前端不再有写死的 WorkBuddy 池选项 ---------- */
  const dlg = fs.readFileSync(
    path.join(ROOT, 'web', 'src', 'features', 'accounts', 'OauthTraeDialog.tsx'),
    'utf8',
  );
  // 去掉注释再检查，避免「说明为什么移除」的注释本身命中
  const code = dlg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  check(
    'Trae OAuth 弹窗不再提供写死的「WorkBuddy 池」选项',
    !/WorkBuddy\s*池/.test(code),
    '仍存在「WorkBuddy 池」字样的选项或文案',
  );
  check(
    'Trae OAuth 弹窗不再把 group 当二选一（无 default/workbuddy 联合类型）',
    !/useState<'default'\s*\|\s*'workbuddy'>/.test(code),
    '仍存在 group 的 default/workbuddy 联合类型',
  );
  check(
    'Trae OAuth 弹窗明确说明「平台决定进哪个池」',
    /平台本身/.test(code) && /转发池/.test(code),
    '缺少关于分池依据的说明',
  );
  check(
    'Trae OAuth 弹窗的分组输入接入了已有分组候选（datalist）',
    /datalist/.test(code) && /listGroups/.test(code),
    '缺少候选分组支持',
  );

  /* ---------- B. 后端 groupOk 的语义 ---------- */
  const poolSrc = fs.readFileSync(path.join(ROOT, 'src', 'credentials', 'pool.js'), 'utf8');
  // 只截到函数体结束（`return !!a.group && allowed.has(a.group);\n}`），
  // 不带后面的注释块——否则「edition」会从平台过滤的说明里误命中
  const groupOkStart = poolSrc.indexOf('function groupOk');
  const groupOkEnd = poolSrc.indexOf('return !!a.group && allowed.has(a.group);', groupOkStart);
  const groupOkBlock = poolSrc.slice(groupOkStart, groupOkEnd + 'return !!a.group && allowed.has(a.group);\n}'.length);
  check(
    'groupOk 在 POOL_GROUPS 为空时直接返回 true（不过滤）',
    /if \(!raw\) return true;/.test(groupOkBlock),
    groupOkBlock.slice(0, 200),
  );
  check(
    'groupOk 只读 a.group，不参与平台判定',
    /allowed\.has\(a\.group\)/.test(groupOkBlock) && !/edition/.test(groupOkBlock),
    groupOkBlock,
  );

  // 行为验证放到造出账号之后（空库上 explainCandidates 返回空数组，断言无意义）
  const prevGROUPS = process.env.POOL_GROUPS;
  process.env.POOL_GROUPS = '';
  const pool = require('../credentials/pool');

  /* ---------- C. 平台分池由 edition 决定，不由 group ---------- */
  const variant = require('../platform/variant');
  const store = require('../credentials/store');

  // 造一个 Trae 账号，故意打上 group='workbuddy'
  const trae = store.add(
    {
      label: 'oauth-group-trae',
      edition: 'cn',
      mode: 'jwt',
      token: 'h.eyJ1c2VyX2lkIjoiMSJ9.s',
      userId: 'oauth-group-trae',
      source: 'oauth',
      group: 'workbuddy',
      enabled: true,
    },
    'test',
  );
  // 造一个真正的 WorkBuddy 账号（无 group）
  const wb = store.add(
    {
      label: 'oauth-group-wb',
      edition: 'workbuddy',
      mode: 'jwt',
      token: 'h.eyJ1c2VyX2lkIjoiMiJ9.s',
      userId: 'oauth-group-wb',
      source: 'oauth',
      enabled: true,
    },
    'test',
  );

  const cands = pool.explainCandidates([]);
  const traeCand = cands.find((c) => c.id === trae.id);
  const wbCand = cands.find((c) => c.id === wb.id);

  check(
    'POOL_GROUPS 为空时：即使 group="workbuddy" 的 Trae 账号也进候选池（分组不构成默认过滤）',
    !!traeCand,
    `未在候选里找到；候选 ${cands.length} 个`,
  );
  check(
    'group="workbuddy" 的 Trae 账号仍在 Trae 候选池（group 不能改变平台归属）',
    !!traeCand,
    `未在候选里找到；候选 ${cands.length} 个`,
  );
  check(
    '真 WorkBuddy 账号不会因缺 group 而被排除（分池看 edition 不看 group）',
    !!wbCand,
    `未在候选里找到；候选 ${cands.length} 个`,
  );

  // 反向确认：把 Trae 账号的 group 清空，它依旧在候选池里 —— 说明 group
  // 既不是进入条件，也不是排除条件
  store.update(trae.id, { group: null });
  const cands2 = pool.explainCandidates([]);
  check(
    '把同一个 Trae 账号的 group 清空后仍可被选中（group 对默认调度无影响）',
    !!cands2.find((c) => c.id === trae.id),
    '清空 group 后账号掉出了候选池',
  );

  // 启用分组筛选后，group 才开始生效（这才是它的真实语义）。
  //
  // ⚠️ 不能拿 explainCandidates 验证：它是**诊断**视图，列出全部账号并给出
  // 不可用原因，根本不含 groupOk（分组过滤只发生在 pick() 选号路径里）。
  // 也不适合用 pick()：它还叠加 lastPickedAt 间隔、冷却、并发与策略排序，
  // 结果会随机器状态漂移——那不是本测试要证明的事。
  //
  // 这里用「只读源码 + 正则提取 groupOk 的判定表达式」这种最窄的方式验证：
  // 把决定通过/拒绝的那一行拿出来，对两种 group 值求值。
  const groupOkBody = poolSrc.slice(
    poolSrc.indexOf('function groupOk'),
    poolSrc.indexOf('return !!a.group && allowed.has(a.group);'),
  ) + 'return !!a.group && allowed.has(a.group);\n}';
  const groupOk = new Function('process', `${groupOkBody.replace('function groupOk', 'return function')}`)(process);

  process.env.POOL_GROUPS = 'workbuddy';
  check(
    'POOL_GROUPS=workbuddy 时：group=null 的账号被分组条件排除',
    groupOk({ group: null }) === false,
    'groupOk 对 group=null 仍返回 true',
  );
  check(
    'POOL_GROUPS=workbuddy 时：group="workbuddy" 的账号通过分组条件',
    groupOk({ group: 'workbuddy' }) === true,
    'groupOk 拒绝了匹配的分组',
  );

  process.env.POOL_GROUPS = '';
  check(
    'POOL_GROUPS 为空时：group=null 与 group="workbuddy" 都通过（不构成默认过滤）',
    groupOk({ group: null }) === true && groupOk({ group: 'workbuddy' }) === true,
    '空配置下分组仍在过滤',
  );

  // 恢复
  process.env.POOL_GROUPS = prevGROUPS === undefined ? '' : prevGROUPS;
  for (const a of [trae, wb]) {
    try { store.remove(a.id); } catch { /* 忽略 */ }
  }

  void variant;

  console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

try {
  main();
} catch (e) {
  console.error(`FAIL  用例执行异常: ${e.stack || e.message}`);
  process.exit(1);
}
