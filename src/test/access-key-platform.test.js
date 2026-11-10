'use strict';
/**
 * src/test/access-key-platform.test.js —— 访问密钥的**平台可选性**。
 *
 * ## 这个测试要钉住的真实故障（2026-11-09）
 *
 * 用户报：「前端创建访问密钥时，不能选择创建平台，只能默认为 all」。
 *
 * 根因在 `web/src/features/accounts/AccessKeysPage.tsx`：创建走的是
 * `prompt({ input: { label: '备注' } })`，而 `prompt` 只支持**一个文本输入框**，
 * 于是 platform 被硬编码：
 *
 * ```js
 * await createAccessKey({ label: label.trim() || undefined, platform: 'all' }, key);
 * ```
 *
 * 后端 `PLATFORMS = trae | workbuddy | all` 一直是完整支持的（三个都验证过
 * 能建出密钥），只是前端从不给用户选的机会。
 *
 * ## 为什么这不是「少一个下拉框」那么简单
 *
 * platform 决定 `DEFAULT_SCOPES` / `DEFAULT_RESOURCES`：
 *   - `trae`      → `model:trae/*`
 *   - `workbuddy` → `model:workbuddy/*`
 *   - `all`       → `*`
 *
 * 「只能建 all」= 用户**无法把密钥权限收窄**，手里每把钥匙都是全能钥匙。
 * 给 IDE 一把、给脚本一把的最小权限实践因此做不了；密钥泄露的影响面也无法控制。
 *
 * ## 测试策略
 *
 * 前端是 .tsx，node 里不能直接 require。这里做两类检查：
 *   1. **源码静态约束**（与 `frontend-entitlement.test.js` 同款做法）：
 *      创建路径不得再把 platform 写死，且必须引用新的平台清单；
 *   2. **前后端清单一致性**：从前端源码里抽出平台字面量，与后端
 *      `credentials/api-keys.js#PLATFORMS` 逐字比对 —— 分叉的后果是
 *      「前端能选、后端 400」，而 400 文案会把用户引向后端的值。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// 隔离状态目录：下面要 require 后端 api-keys（它会连 DB）
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR
  || path.join(require('node:os').tmpdir(), `rg-akp-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = process.env.TRAE_API_ENCRYPT_KEY || 'a'.repeat(64);

const ROOT = path.join(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'web', 'src', 'features', 'accounts', 'AccessKeysPage.tsx');
const DIALOG = path.join(ROOT, 'web', 'src', 'features', 'accounts', 'CreateAccessKeyDialog.tsx');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

/** 去掉注释，避免注释里的示例被当成真实代码命中。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/* ---------- 1. 页面：不得再硬编码 platform ---------- */

t('AccessKeysPage 不再把 platform 写死成 all', () => {
  const src = stripComments(fs.readFileSync(PAGE, 'utf8'));
  // 精确匹配「platform: 'all'」这种字面量（允许双引号）
  assert.ok(
    !/platform\s*:\s*['"]all['"]/.test(src),
    'AccessKeysPage 仍在硬编码 platform:\'all\' —— 用户无法选择平台',
  );
});

t('AccessKeysPage 挂载了新弹窗 CreateAccessKeyDialog', () => {
  const src = stripComments(fs.readFileSync(PAGE, 'utf8'));
  assert.ok(/CreateAccessKeyDialog/.test(src), '页面必须挂载平台选择弹窗');
  // 且必须是**打开/关闭受控**的（不是永远 open）
  assert.ok(/open=\{/.test(src), '弹窗必须受控（open={...}）');
});

t('AccessKeysPage 的创建按钮走弹窗状态，而不是直接调 API', () => {
  const src = stripComments(fs.readFileSync(PAGE, 'utf8'));
  const createFn = src.slice(src.indexOf('async function create()'), src.indexOf('async function rotate('));
  assert.ok(createFn.length > 0, '必须仍存在 create 函数');
  assert.ok(
    !/createAccessKey\s*\(/.test(createFn),
    'create() 不应再直接调用 createAccessKey —— 平台选择在弹窗里决定',
  );
});

/* ---------- 2. 弹窗：平台清单与后端一致 ---------- */

t('CreateAccessKeyDialog 声明的平台与后端 PLATFORMS 逐字一致', () => {
  const dialogSrc = stripComments(fs.readFileSync(DIALOG, 'utf8'));
  const { PLATFORMS } = require('../credentials/api-keys');
  const backend = Array.from(PLATFORMS).sort();

  // 从 PLATFORM_OPTIONS 里抽 value: 'xxx'
  const block = dialogSrc.slice(
    dialogSrc.indexOf('const PLATFORM_OPTIONS'),
    dialogSrc.indexOf('] as const'),
  );
  const frontend = Array.from(block.matchAll(/value:\s*'([a-z]+)'/g)).map((m) => m[1]).sort();

  assert.deepStrictEqual(
    frontend, backend,
    `前端平台清单 [${frontend}] 与后端 [${backend}] 不一致 —— `
    + '分叉表现为「前端能选、后端 400」，而 400 文案会把用户引向后端的值',
  );
});

t('CreateAccessKeyDialog 默认 all（保持升级前后行为一致）', () => {
  const src = stripComments(fs.readFileSync(DIALOG, 'utf8'));
  // 初始值 + 每次打开重置 两处都必须是 all
  const init = src.match(/useState<PlatformValue>\(\s*'([a-z]+)'\s*\)/);
  assert.ok(init, '必须有平台初始状态');
  assert.strictEqual(init[1], 'all', '升级后默认平台不应变化（旧行为是 all）');
});

t('CreateAccessKeyDialog 提交时把用户选的平台传下去', () => {
  const src = stripComments(fs.readFileSync(DIALOG, 'utf8'));
  assert.ok(/createAccessKey\s*\(\s*\{[^}]*platform\s*,/.test(src)
    || /createAccessKey\s*\(\s*\{[^}]*platform\s*\}/.test(src),
  '提交必须传 platform（不能像旧代码那样写死）');
});

/* ---------- 3. 后端语义对照：platform 决定 resources ---------- */

t('后端：platform 决定默认 resources（这是「收窄权限」的实际机制）', () => {
  const ak = require('../credentials/api-keys');
  assert.deepStrictEqual(ak.DEFAULT_RESOURCES.all, ['*']);
  assert.deepStrictEqual(ak.DEFAULT_RESOURCES.trae, ['model:trae/*']);
  assert.deepStrictEqual(ak.DEFAULT_RESOURCES.workbuddy, ['model:workbuddy/*']);
});

t('后端：三个平台都能真的建出密钥（platform 校验通过）', () => {
  const ak = require('../credentials/api-keys');
  const made = [];
  try {
    for (const p of ['trae', 'workbuddy', 'all']) {
      assert.ok(ak.PLATFORMS.has(p), `${p} 必须在后端 PLATFORMS 里`);
      const created = ak.createKey({ label: `ut-${p}`, kind: 'access', platform: p });
      made.push(created.id);
      assert.ok(created.key, 'createKey 必须返回明文一次');
      assert.strictEqual(created.platform, p, '落库的 platform 必须等于请求值');
      const full = ak.getKey(created.id);
      assert.deepStrictEqual(
        full.resources, ak.DEFAULT_RESOURCES[p],
        `${p} 的默认 resources 不对`,
      );
    }
  } finally {
    for (const id of made) { try { ak.deleteKey(id); } catch { /* 清理失败不影响断言 */ } }
  }
});

t('后端：非法平台被拒（前端若分叉会撞上这条）', () => {
  const ak = require('../credentials/api-keys');
  assert.ok(!ak.PLATFORMS.has('raccoon'), 'raccoon 不是密钥平台（它是模型渠道，不是密钥维度）');
  assert.ok(!ak.PLATFORMS.has('qoder'));
  assert.ok(!ak.PLATFORMS.has('zcode'));
});

/* ---------- 运行 ---------- */

(async () => {
  for (const { name, fn } of queue) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      pass += 1;
      console.log(`  ok  ${name}`);
    } catch (e) {
      fail += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${e && e.message}`);
    }
  }
  console.log('');
  console.log(`访问密钥平台测试：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
  process.exit(fail ? 1 : 0);
})();
