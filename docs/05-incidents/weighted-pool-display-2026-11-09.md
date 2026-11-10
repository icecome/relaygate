# 加权轮转的权重「只有第一个生效」——前端池判定与后端调度不同义（2026-11-09）

> **一句话**：后端权重一直是对的（库里 `weight=8/8/7/6` 全在），错的是前端
> `ModelRouterPage` 里决定「哪些候选算轮转池成员」的三行代码 —— 它在
> `rotateTopN=0` 时对**所有策略**都只取第一个候选，于是加权轮转的权重列
> 除了第一个全显示 `—`，而用户看到 `—` 会以为「权重没存上」，反复重填。
>
> **性质**：界面在撒谎，调度没坏。这比调度坏更难发现。

## 现象

用户新建虚拟模型，策略选「加权轮转」，4 个候选（sn-deepseek-v4-1-flash /
sn-glm-5-3-flash / sn-glm-5-3 / sn-kimi-k3）**逐个填了权重**（8/8/7/6），
保存后表格里：

- 「权重」列：第一个显示 `8`，其余三个全是 `—`；
- 「轮转」提示：显示「轮转 **1** 个候选」；
- 用户原话：「以前添加也出现，总是只有第一个有权重数值」。

## 根因

`web/src/features/models/ModelRouterPage.tsx`（修复前）：

```js
const poolSize = v.rotateTopN ?? 0;
const poolIds = new Set(
  poolSize > 0
    ? costSorted.slice(0, poolSize).map((c) => c.id)
    : costSorted.slice(0, 1).map((c) => c.id),   // ← 永远只取第一个
);
```

`slice(0, 1)` 的语义是给 **priority** 策略写的：优先级策略确实「固定用第一个
候选，其余是降级备胎」，所以池里只有 1 个是对的。

但 **weighted** 策略下，「池」必须是**全部启用候选** —— 没有池，权重无处施力。
两种策略共用同一句 fallback，于是 weighted 被当成了 priority 的子集。

手动虚拟模型（`auto: false`）的 `rotateTopN` 默认是 `0`（见
`model-router.json` 与 `store.normalizeVirtual`），而表格里调节 `rotateTopN`
的 Stepper **只对 `v.auto` 渲染**，所以手动模型永远走不到 `poolSize > 0` 分支
—— 100% 复现。

## 为什么后端没问题

`src/model-router/index.js#orderCandidates` 一直是正确的：

```js
if (vm.strategy === 'weighted') {
  return weightedShuffle(list);      // 全部候选参与加权无放回抽样
}
return list.slice().sort((a, b) => (a.priority - b.priority) || ...);
```

`weightedShuffle` 也是标准实现（按 `weight` 总量随机取，取完移除）：

```js
const pool = list.map((c) => ({ c, w: Math.max(1, Number(c.weight) || 1) }));
// 每轮：total = Σw；r = random()*total；累减定位；取出并 splice
```

所以**请求确实在按权重轮转**，只是界面没把这件事显示出来。

## 修复

### 1. 池判定按策略分开（核心）

```js
const poolSize = v.rotateTopN ?? 0;
const weighted = v.strategy === 'weighted';
const poolList = weighted && poolSize <= 0
  ? costSorted                                            // weighted：全部启用候选
  : (poolSize > 0 ? costSorted.slice(0, poolSize)         // 显式声明：按声明截断
                  : costSorted.slice(0, 1));              // priority：固定第一个
const poolIds = new Set(poolList.map((c) => c.id));
```

三条不变式：
- weighted 且未声明 `rotateTopN` → 池 = 全部启用候选（**本次修复**）；
- 显式 `rotateTopN > 0` → 按声明截断（autotier 生成模型依赖此语义，不能动）；
- priority 且 `rotateTopN = 0` → 仍只取第一个（**不能改坏**）。

### 2. 「轮转 N 个候选」的提示文案按策略区分

```js
{(!v.auto || v.strategy === 'weighted') && poolIds.size > 0 && (
  <div title={v.strategy === 'weighted'
    ? '加权轮转：池内全部启用候选按权重随机排序，权重越大越常被排到前面。'
    : '优先级：按优先级升序固定取第一个候选，其余仅在失败/限流时按顺序回退。'}>
    轮转 {poolIds.size} 个候选
  </div>
)}
```

此前只对 `!v.auto` 渲染，且没有解释两种策略的差别 —— 用户看到「轮转 1 个」
无法判断这是 bug 还是设计。

### 3. 回归测试 `src/test/virtual-model-pool.test.js`（9 项）

用与前端**同构**的 `poolIdsOf()` 镜像钉住语义：

| 用例 | 断言 |
|---|---|
| weighted + rotateTopN=0 | 池大小 = 4（曾是 1） |
| weighted + rotateTopN=0 | 渲染出的权重是 `[8,8,7,6]` 而非 `[8,—,—,—]` |
| priority + rotateTopN=0 | 池大小仍 = 1（语义未改坏） |
| weighted + rotateTopN=2 | 按声明截断为 2 |
| 置顶候选 | 额外入池且不占名额 |
| 禁用候选 | 不占池名额 |
| 空候选 | 不崩 |
| 后端源码 | `vm.strategy === 'weighted'` → `weightedShuffle(list)` 存在 |
| weightedShuffle | 权重下限夹到 1、按总量抽样 |

## 教训（写给下次改这里的人）

1. **「界面显示」与「调度行为」必须由同一个判据驱动**。这次两边各写一份
   「谁在池里」，后端对、前端错，于是产生了一个「调度正确但看起来全坏」的
   故障 —— 排查成本远高于两边都错。
2. **共用的 fallback 是策略分叉的高危点**。`poolSize > 0 ? ... : slice(0,1)`
   之所以写错，是因为它把两种策略的默认值合并成了一句。新增策略时，
   **先问「它的默认池是什么」**，不要复用别人的默认值。
3. **默认值为 0 的字段 + 只对某类对象渲染的控件 = 某个分支永远走不到**。
   手动 VM 的 `rotateTopN=0` 加上「Stepper 只对 auto 渲染」，让
   `poolSize > 0` 分支对手动模型完全不可达。
4. **用户说「以前也这样」时，先去查数据，别先查代码**。库里 `weight=8/8/7/6`
   摆在那里，五分钟就能排除「没保存」这个方向。

## 验证

```bash
npm run build:web                                    # 前端必须能编译
node src/test/virtual-model-pool.test.js             # 9 项语义回归
node src/test/raccoon-proxy.test.js                  # 30 项（含 Provider 接线）
```

实测数据（修复后，`GET /v1/admin/model-router/virtual`）：

```
VM: raccoon  strategy=weighted  rotateTopN=0
  sn-deepseek-v4-1-flash  weight=8
  sn-glm-5-3-flash        weight=8
  sn-glm-5-3              weight=7
  sn-kimi-k3              weight=6
```

界面现在应显示 4 个权重值 + 「轮转 4 个候选」。
