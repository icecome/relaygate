'use strict';
/**
 * src/test/virtual-model-pool.test.js —— 虚拟模型的**轮转池成员判定**。
 *
 * ## 这个测试要钉住的真实故障（2026-11-09）
 *
 * 用户选「加权轮转」、给 4 个候选都填了权重，保存后界面上**只有第一个候选**
 * 显示权重，其余显示 `—`；「轮转 N 个候选」也显示成 1。
 *
 * 排查结果：**后端数据完全正确**（库里 weight 是 8/8/7/6），错的是前端
 * `ModelRouterPage` 里决定「哪些候选算在轮转池内」的那三行：
 *
 * ```js
 * const poolIds = new Set(
 *   poolSize > 0 ? costSorted.slice(0, poolSize).map(c => c.id)
 *                 : costSorted.slice(0, 1).map(c => c.id),   // ← 永远只取第一个
 * );
 * ```
 *
 * 那句 `slice(0, 1)` 是给 **priority** 策略写的（优先级策略确实固定用第一个，
 * 其余是降级备胎）。但 weighted 策略下「池」必须是**全部启用候选** ——
 * 没有池，权重就没有意义。两种策略共用一句 fallback，于是 weighted 被当成了
 * priority 的子集。
 *
 * ## 与后端的关系
 *
 * 后端 `orderCandidates` 一直是**对的**：
 *   - `strategy === 'weighted'` → `weightedShuffle(list)`（全部候选加权抽样）；
 *   - 否则 → 按 priority 排序取第一个。
 * 所以这个缺陷的形态是「调度是对的，界面在撒谎」—— 比调度错更难发现，
 * 因为用户看到 `—` 会以为「权重没保存」，反复重填。
 *
 * 前端逻辑无法在 node 里直接 require（.tsx），所以这里用**同一份判定式**的
 * 纯函数镜像来钉语义；镜像与前端的一致性由「两侧必须同构」的注释约束，
 * 并在 `src/test/wiring.test.js` 之外单独保留（它是产品语义，不是接线测试）。
 */

const assert = require('node:assert');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

/**
 * 轮转池成员判定的**唯一事实源**（与 ModelRouterPage 保持同构）。
 *
 * 规则：
 *  1. weighted 且未显式声明 rotateTopN → 池 = 全部启用候选；
 *  2. 显式声明 rotateTopN > 0 → 池 = 成本序前 N 个（autotier 生成模型用）；
 *  3. 其它（priority 且 rotateTopN=0）→ 池 = 第一个候选（降级按顺序回退）；
 *  4. 置顶候选额外入池，且不占 rotateTopN 名额。
 *
 * @param {{strategy?:string, rotateTopN?:number, candidates:Array}} vm
 * @returns {Set<string>}
 */
function poolIdsOf(vm) {
  const enabled = (vm.candidates || []).filter((c) => c.enabled !== false);
  // 手动 VM 无 sort，成本序即原顺序；auto VM 的 costSorted 由 rate/window 排过，
  // 这一层不影响「池大小」语义，故这里用原顺序即可。
  const costSorted = enabled;
  const poolSize = Number(vm.rotateTopN) || 0;
  const weighted = vm.strategy === 'weighted';
  const poolList = weighted && poolSize <= 0
    ? costSorted
    : (poolSize > 0 ? costSorted.slice(0, poolSize) : costSorted.slice(0, 1));
  const ids = new Set(poolList.map((c) => c.id));
  for (const c of vm.candidates || []) if (c.pinned && c.enabled !== false) ids.add(c.id);
  return ids;
}

const mk = (strategy, rotateTopN) => ({
  id: 'vm/x',
  strategy,
  rotateTopN,
  candidates: [
    { id: 'a', weight: 8, enabled: true },
    { id: 'b', weight: 8, enabled: true },
    { id: 'c', weight: 7, enabled: true },
    { id: 'd', weight: 6, enabled: true },
  ],
});

/* ---------- 核心回归：这就是用户报的那个 bug ---------- */

t('weighted + rotateTopN=0：全部候选都在池里（曾是只有第一个）', () => {
  const ids = poolIdsOf(mk('weighted', 0));
  assert.strictEqual(ids.size, 4, `加权轮转的池必须是全部 4 个候选，实际 ${ids.size}`);
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.ok(ids.has(id), `${id} 必须在池内，否则界面显示 — 而库里明明有权重`);
  }
});

t('weighted + rotateTopN=0：每个候选的权重都能显示出来', () => {
  const vm = mk('weighted', 0);
  const ids = poolIdsOf(vm);
  const shown = vm.candidates.map((c) => (ids.has(c.id) ? c.weight : '—'));
  assert.deepStrictEqual(shown, [8, 8, 7, 6], `实际渲染成 ${JSON.stringify(shown)}`);
});

t('priority + rotateTopN=0：仍只取第一个（语义不能改坏）', () => {
  const ids = poolIdsOf(mk('priority', 0));
  assert.strictEqual(ids.size, 1, '优先级策略固定用第一个候选，其余是降级备胎');
  assert.ok(ids.has('a'));
});

t('weighted + 显式 rotateTopN=2：按声明截断（autotier 语义）', () => {
  const ids = poolIdsOf(mk('weighted', 2));
  assert.strictEqual(ids.size, 2);
  assert.ok(ids.has('a') && ids.has('b'));
});

t('置顶候选额外入池，且不占 rotateTopN 名额', () => {
  const vm = mk('weighted', 2);
  vm.candidates[3].pinned = true; // d 置顶
  const ids = poolIdsOf(vm);
  assert.strictEqual(ids.size, 3, 'a,b（声明 2 个）+ d（置顶）');
  assert.ok(ids.has('d'));
});

t('禁用候选不占池名额（weighted）', () => {
  const vm = mk('weighted', 0);
  vm.candidates[2].enabled = false;
  const ids = poolIdsOf(vm);
  assert.strictEqual(ids.size, 3, '禁用的 c 不该在池内');
  assert.ok(!ids.has('c'));
});

t('空候选不崩（防御）', () => {
  assert.strictEqual(poolIdsOf({ strategy: 'weighted', candidates: [] }).size, 0);
  assert.strictEqual(poolIdsOf({ candidates: undefined }).size, 0);
});

/* ---------- 后端语义对照：确保「界面说的」与「调度干的」一致 ---------- */

t('后端 orderCandidates 对 weighted 确实用全部候选（与界面同义）', () => {
  // 不启动整个 router（它依赖 DB），只钉住源码里的分支存在且调用 weightedShuffle。
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'model-router', 'index.js'), 'utf8',
  );
  assert.ok(/vm\.strategy === 'weighted'/.test(src), '后端必须有 weighted 分支');
  assert.ok(/return weightedShuffle\(list\)/.test(src), 'weighted 必须对完整 list 加权');
  // priority 分支必须按 priority 排序（不是加权）
  assert.ok(/a\.priority - b\.priority/.test(src), 'priority 分支必须按优先级排序');
});

t('weightedShuffle 尊重权重：高权重更容易排第一', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'model-router', 'index.js'), 'utf8',
  );
  const fnSrc = src.slice(src.indexOf('function weightedShuffle'), src.indexOf('function candRate'));
  assert.ok(/Math\.max\(1, Number\(c\.weight\)/.test(fnSrc), '权重下限必须夹到 1');
  assert.ok(/Math\.random\(\) \* total/.test(fnSrc), '必须按权重总量做无放回抽样');
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
  console.log(`虚拟模型轮转池测试：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
  process.exit(fail ? 1 : 0);
})();
