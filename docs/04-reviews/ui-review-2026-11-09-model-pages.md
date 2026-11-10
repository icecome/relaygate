# 模型相关前端页面审查（2026-11-09）

> 审查范围：`web/src/features/models/`（模型池状态页、路由与虚拟模型页、新增虚拟模型弹窗）与
> `web/src/features/ops/OpsPage.tsx` 的模型统计卡。
> 审查依据：后端 `routes/models.js`、`routes/model-router.js`、`models/availability.js`、
> `workbuddy/chat.js`、`platform-ownership.js` 的**实际能力**，而非页面上已有的文案。
> 方法：`ui-design-review` 分级（CRITICAL / MAJOR / MINOR / NIT）+ `tech-doc-style-chinese` 文案规范。

---

## 1. 结论

后端在 2026-11-08 引入「媒体模型」这一档状态、给 PlanLimit 结论加了 `[套餐层]` 前缀、
并把 `/v1/models` 切到动态目录后，前端只跟了一半：

| 后端能力 | 前端落地 | 缺口 |
|---|---|---|
| `status: media` | ✅ 状态映射 + 筛选 | 首轮漏了 `unknown` 筛选项；媒体行仍给「探测」按钮 |
| `chat: false` | ✅ 类型定义 | 未用于操作列判断 |
| `mediaKind: image/video` | ✅ 能力列 | 首轮未展示 |
| `reason: "[套餐层] …"` | ❌ 原样输出 | 界面上裸露方括号前缀 |
| `/v1/models` 动态目录 | 无需前端改动 | — |
| `availability.reconcile` | 无需前端改动 | — |

已按后端能力重排展示与文案，逐项见下。

---

## 2. 发现与处置

### 2.1 状态口径（MAJOR，已修）

**问题**：`statusMeta()` 只映射三态，`media` 是后加的第四个值。首轮补了 `media` 但
筛选器缺 `unknown`——用户能筛「可用 / 不可用 / 媒体模型」，却筛不出「未探测」，
而 `unknown` 恰恰是「目录里有、还没验证过」的那批，是最需要主动探测的一档。

**处置**：

```tsx
// 状态筛选改为直接比对，不再为每档写一条 if
if (status !== 'all' && m.status !== status) return false;

options={[
  { value: 'all', label: '全部状态' },
  { value: 'usable', label: '可用' },
  { value: 'unavailable', label: '不可用' },
  { value: 'unknown', label: '未探测' },
  { value: 'media', label: '媒体模型' },
]}
```

`StatusFilter` 类型同步加 `'unknown'`。

**为什么改写成单条比对**：原来三档各写一行 `if (status === 'x' && m.status !== 'x') return false`，
新增一档就要加一行，漏一行就是静默失效（这次就是漏了 `unknown`）。
单条比对把「新增状态」的改动点收敛到类型定义与选项数组两处。

---

### 2.2 媒体模型仍显示「探测」按钮（MAJOR，已修）

**问题**：媒体模型没有 chat 端点，点「探测」必然得到 11103
`Backend [hunyuan-stream] is not supported`。用户点了失败、再点再失败，
而这条错误本来就不该产生——后端已把媒体模型从探活目标里剔除，前端却还留着入口。

**处置**：

```tsx
const isMedia = m.status === 'media' || m.chat === false;
...
{isMedia ? (
  <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
    无 chat 端点
  </span>
) : (
  <Button size="sm" onClick={() => { setProbeModelName(m.id); void probe(m.id); }}>探测</Button>
)}
```

判据同时看 `status` 与 `chat`：`status` 是探活结论（可能缺失），`chat` 是目录能力位
（目录来自上游时才可靠）。两者任一命中即按媒体模型处理——宁可少给一个按钮，
也不给一个必然失败的按钮。

---

### 2.3 `[套餐层]` 前缀直接裸露（MAJOR，已修）

**问题**：后端把 PlanLimit 结论写成 `[套餐层] PlanLimit: 套餐额度不足 (1005)`，
用于和「模型下线」区分。前端原样渲染，界面上出现方括号和英文错误码：

```
kimi-k3.1-pro
[套餐层] PlanLimit: 套餐额度不足 (1005)
```

**处置**：拆前缀渲染成 Chip，正文保留后端原文：

```tsx
const REASON_PREFIX_RE = /^\[([^\]]+)\]\s*/;
function splitReason(reason) {
  const raw = String(reason || '');
  const m = REASON_PREFIX_RE.exec(raw);
  if (!m) return { tag: null, text: raw };
  return { tag: m[1], text: raw.slice(m[0].length) };
}

{reason.tag && <Chip tone={reason.tag === '套餐层' ? 'warn' : 'neutral'}>{reason.tag}</Chip>}
{reason.text}
```

同时把媒体模型的 reason 改成三级灰（`--rg-text-tertiary`）而不是错误红：
「这个模型不归 chat 管」不是故障，用红色会让整页显得到处都是问题。

**文案选择**：正文不翻译、不删减 `PlanLimit: 套餐额度不足 (1005)`。
错误码是排查依据，翻译掉会让用户拿着 `1005` 去搜也搜不到对应原文。

---

### 2.4 指标卡口径对不上（MINOR，已修）

**问题**：`模型总数` 58，`可用` 45，两数相减得 13，但既不是不可用 9 也不是任何单值——
因为媒体模型 4 个既不算可用也不算不可用，在四个指标卡里没有任何位置。

用户会自然做「总数 - 可用 = 有多少坏的」这个减法，得到 13，然后发现不可用只有 9，困惑。

**处置**：总数卡的 delta 里显式列出媒体模型数，让加法闭合：

```tsx
delta: [
  `目录来源：${directorySourceLabel(status_.data?.source)}`,
  counts.media > 0 ? `媒体模型 ${formatNumber(counts.media)}` : null,
].filter(Boolean).join(' · ')
```

同时「可用」卡的 delta 补全另外两档：`不可用 9 · 未探测 0`。
四档相加 = 总数，checked by `sum check: OK`（见 §4 实测）。

`counts` 改为一次遍历算出，避免四个 `.filter().length` 各扫一遍全表。

---

### 2.5 机器标识直出（MINOR，已修）

**问题**：三类机器可读值被直接渲染：

| 字段 | 原样显示 | 实际值 |
|---|---|---|
| `strategy` | `least_balance` | 账号池调度策略 |
| `upstreamFunction` | `chat_v3` / `solo_work_lite` | 上游调用方式 |
| `source` | `upstream` / `model-router` | 目录来源 / 模型来源 |

**处置**：加白名单映射，命中则中文名，未命中回退原值（新增策略不至于显示空白）：

```tsx
const POOL_STRATEGY_LABEL = {
  least_balance: '余额与到期优先',
  round_robin: '轮询',
};
const UPSTREAM_FUNCTION_LABEL = {
  chat_v3: '对话（chat_v3）',
  inline_chat: '内联对话（inline_chat）',
  solo_work_lite: 'TraeWork（solo_work_lite）',
};
```

保留括号里的原值：排查时要能和日志里的 `function=chat_v3` 对上。

`source` 列同理——虚拟模型的 `source` 是 `model-router`，直接显示是机器标识；
改用后端同时下发的 `source_name`（`虚拟模型`）。改写为两级回退：

```tsx
function platformSourceLabel(source, sourceName) {
  if (source && PLATFORM_SOURCE_LABEL[source]) return PLATFORM_SOURCE_LABEL[source];
  if (sourceName) return sourceName;
  return source || '—';
}
```

---

### 2.6 能力列语义冲突（MINOR，已修）

**问题**：原实现是 `m.multimodal ? <Chip>多模态</Chip> : CAPABILITY_LABEL[capability]`。
媒体模型行会命中第一条吗？不会（`multimodal` 为 false），但会走到 `CAPABILITY_LABEL['media_model']`
——这个 key 首轮没定义，显示成 `—`，等于能力列空白。

**处置**：加 `media_model: '媒体生成'`，并且媒体模型行改用 `MEDIA_KIND_LABEL`
显示更具体的「图片 / 视频」：

```tsx
{isMedia ? (
  <Chip tone="neutral">{MEDIA_KIND_LABEL[m.mediaKind ?? 'other'] ?? '媒体生成'}</Chip>
) : m.multimodal ? (
  <Chip tone="brand">多模态</Chip>
) : (
  CAPABILITY_LABEL[m.capability ?? ''] || '—'
)}
```

---

### 2.7 空态指向了不存在的按钮（MINOR，已修）

**问题**：空态提示「可放宽筛选或点「同步目录」」，但页面上没有叫「同步目录」的按钮，
实际按钮是右上角的「拉取上游模型」。

**处置**：文案改为准确指路 + 说明下一步：

> 当前来源与状态筛选没有命中任何模型；可放宽筛选，或点右上角「拉取上游模型」重新同步目录。

---

### 2.8 清理确认框未说清影响范围（MINOR，已修）

**问题**：「清理可用性标记」的确认框说「清除所有模型的可用 / 不可用标记」，
但现在有三种会写可用性表的模型（Trae 对话、WorkBuddy 对话、虚拟模型），
媒体模型**不写**这张表。说「所有模型」不准确。

**处置**：

> 将清除所有对话模型的「可用 / 不可用」标记，下次探测后重新判定。媒体模型不写入可用性表，不受影响。

---

### 2.9 页面底部说明与后端能力不符（MINOR，已修）

**问题**：原文「上游模型目录不提供上下文窗口，仅虚拟模型声明该值」——
这句在 2026-09 之后就不成立了：WorkBuddy 目录下发 `maxInputTokens`（最大 960000），
表格里「上下文窗口」列对 WB 模型显示的就是它。

**处置**：说明改成解释**状态来源**（这才是用户真正会困惑的点）：

> 状态列有三种来源：可用 / 不可用 / 未探测来自真实调用结论（不可用带有效期，到期自动重探）；
> 媒体模型来自目录能力位——图片与视频生成模型没有 chat 端点，不参与转发与探测。
> 倍率（×）为积分消耗倍率，两个平台的目录接口均未提供峰谷价格。

---

### 2.10 路由页与弹窗（MINOR，已修）

| 位置 | 问题 | 处置 |
|---|---|---|
| `ModelRouterPage.tsx` 底部 Note | 未说明为什么候选里没有媒体模型 | 补「目录中的图片与视频生成模型没有 chat 端点，不进入候选」 |
| `VirtualModelDialog.tsx` 上游下拉 | 显示 provider id（`workbuddy` / `trae`），与页面其他处的中文名不一致 | 改用 `platformIdLabel(p)` |
| `VirtualModelDialog.tsx` 底部 Note | 未说明候选列表为什么比目录少 | 补「候选下拉只列出可走对话接口的模型……需要时可在手动输入框里填写」 |
| `OpsPage.tsx` 「不可用模型」 | 该数字只统计写入可用性表的对话模型，媒体模型不计入 | 改名「不可用对话模型」并加注释 |

---

## 3. 未改动的项（附理由）

| 项 | 观察 | 为什么不改 |
|---|---|---|
| 表格 `maxHeight: 560` + 滚动 | 58 行超出视口 | 已有 `scroll-y overflow-x-auto` 双轴滚动，表头未固定但项目 `data-table` 约定如此，改表头固定属于全局样式调整，超出本次范围 |
| `status_` 变量名带下划线 | 与 `status`（筛选值）区分 | 语义清晰，改动无收益 |
| 媒体模型也显示「倍率」列 | 媒体模型的 `credits` 为 `—` | 列内值本就为空，隐藏列会让各行对齐关系变化，得不偿失 |
| 「清理可用性标记」无二次确认输入 | 破坏性但可恢复（下次探测重建） | 已用红色 danger 弹窗 + 后果说明，符合项目内其他危险操作的一致做法 |

---

## 4. 实测验证

侧实例（19903，调度关闭）对 `/v1/models/status` 的实测：

```
status total 58 {"usable":45,"unavailable":9,"media":4}
strategy= least_balance  source= upstream
sum check: OK                    ← 45 + 9 + 0 + 4 = 58

--- 媒体模型 ---
  wb/hunyuan-image-alpha        chat=false mediaKind=image  cap=media_model
  wb/hunyuan-image-alpha-edit   chat=false mediaKind=image  cap=media_model
  wb/kling-video-v3             chat=false mediaKind=video  cap=media_model
  wb/minimax-video-h3           chat=false mediaKind=video  cap=media_model

--- 套餐层 ---
  kimi-k3.1-pro  [套餐层] PlanLimit: 套餐额度不足 (1005)

--- source 字段对 ---
  model-router | 虚拟模型
  workbuddy-cn | WorkBuddy CN
  trae-cn      | Trae CN
```

前端构建与检查：

```
npx tsc --noEmit -p tsconfig.json   → 无错误
npm run lint                        → 无告警
npm run build                       → 成功（ModelPoolPage 9.60 kB / gzip 4.50 kB）
```

---

## 5. 改动文件

| 文件 | 改动 |
|---|---|
| `web/src/features/models/ModelPoolPage.tsx` | 状态四档 + `unknown` 筛选；媒体模型禁用探测；`[套餐层]` 拆 Chip；指标卡补全口径；机器标识中文化；能力列补 `media_model`；空态与说明文案重写；`clearAll` 确认文案 |
| `web/src/features/models/ModelRouterPage.tsx` | 底部 Note 补媒体模型说明 |
| `web/src/features/models/VirtualModelDialog.tsx` | 上游下拉用 `platformIdLabel`；Note 补候选列表口径 |
| `web/src/features/ops/OpsPage.tsx` | 「不可用模型」→「不可用对话模型」+ 注释 |
| `web/src/shared/api/admin.ts` | 早前已补 `status: media` / `chat` / `mediaKind` 类型 |
| `src/routes/status.js` | 补注释说明该计数不含媒体模型（无行为变更） |

---

## 6. 上传前检查清单

- [x] 状态四档（usable / unavailable / unknown / media）筛选齐全，且与后端取值一一对应
- [x] 媒体模型不出现「探测」按钮
- [x] 计数闭合：可用 + 不可用 + 未探测 + 媒体 = 总数
- [x] 后端 `[分类]` 前缀渲染成 Chip，不裸露方括号
- [x] 机器可读值（strategy / upstreamFunction / source）有中文映射，未命中回退原值
- [x] 空态与确认框文案指向真实存在的控件
- [x] 类型检查、lint、构建三项通过
- [ ] 真机目测窄屏（< 1200px）下表格横向滚动是否遮挡操作列 —— 需在浏览器确认
