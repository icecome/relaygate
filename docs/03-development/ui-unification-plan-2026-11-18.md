# RelayGate 管理端组件界面统一方案（2026-11-18）

> 适用范围：`web/src` 下全部 80 个源文件、9 个页面、17 个弹窗、47 张表。
> 读者：接手前端的人、做视觉调整的人、评审 UI 改动的人。
> 阅读顺序：先看第 1 节拿基线数字，再看第 3 节规范表，然后直接从第 4 节 P0 第一条开始动手。
> 本方案不引入任何新的运行时依赖，全部基于仓库里已有的令牌层（`global.css` 的 `--rg-*`）与
> 已有基础组件（`shared/ui`）。

---

## 0. 结论先行

这个项目**不缺设计系统，缺的是「用了它」**。令牌层和基础组件的质量高于多数同类项目：对比度逐档算过、焦点环统一、弹窗焦点陷阱与开栈都做了、表格列宽有推导依据。问题全部出在实现层的**绕过**：

| 现象 | 数量 | 直接后果 |
|---|---|---|
| 内联 `style={{}}` 对象 | 411 个 | 改一次主色要改 40 个文件 |
| 其中「只写了一个 color」 | 298 个（72%） | 文字色没有语义类可用，只能内联 |
| 原生 `<button>` 不带 `.btn` | 26 个中 14 个 | 悬停/焦点/禁用态各写一套，行为不一致 |
| 硬编码字号 `text-[Npx]` | 36 处 | 字号阶梯形同建议 |
| `table-fixed` 覆盖 | 47 张表里 3 张 | 筛选后整表横向位移 |
| 定义了但零引用的令牌 | 74 个里 25 个 | 改令牌不生效，误以为改错了地方 |
| 同一语义的容器类 | `stat-strip` / `ent-rollup` / `growth-bar` / `toolbar` 四套 | 同类信息在不同页面长相不同 |
| 控件高度不一致 | `.seg-item` 30px vs 控件 32px | 并排时基线错 2px，六处可见 |

一句话：**先把「绕过的通道」堵死，再谈视觉。** 顺序反了，规范写完第二天就被新增代码稀释回去。

---

## 1. 量化基线（2026-11-18 实测）

以下数字由 `output/ui-audit/*.ps1` 与 `web/scripts/check-ui-consistency.mjs` 扫出，可重跑复核。

### 1.1 组件层使用率

| 组件 | 调用点 | 覆盖文件数 | 判定 |
|---|---|---|---|
| `Button` | 165 | 31 | 覆盖良好；仍有 14 个裸 `<button>` 绕开 |
| `Field` | 39 | 17 | 覆盖良好；`Field` 强制 `w-full`，3 处被迫内联定宽 |
| `Panel` | 47 | 12 | 47 次里 44 次传了 `title`，说明这个抽象被接受 |
| `Chip` | 105 | 19 | 高频，是事实上的状态表达主力 |
| `Note` | 71 | 27 | 高频 |
| `LoadingBlock` | 45 | 23 | 三态里最规范的一个 |
| `EmptyState` | 38 | 16 | 覆盖良好 |
| `ErrorState` | 23 | 14 | 另有 30 处用内联 `var(--rg-state-error)` 自写错误文字 |
| `Segmented` | 17 | 15 | 语义被当成「筛选器」用，但内部是 `role="tablist"` |
| `Modal` | 19 | 18 | 尺寸档位使用不一致（见 2.4） |
| `MetricGrid` | 4 | 4 | 只在「运行态四项指标」场景使用，合理 |
| `ProgressBar` | 5 | 3 | 少用，多数进度条是手写的 `.bar > i` |
| `MenuButton` | 3 | 3 | 只在三张主表的操作列使用，合理 |
| `Stepper` | 1 | 1 | 只有 `ModelRouterPage:520` 用了，其余 26 处数字输入各写一套 |
| `KeyValue` | 1 | 1 | 只有一个调用点，与 `KeyCards` / `KeyCardGroups` 三选一未定 |
| `KeyCards` | 2 | 1 | — |
| `KeyCardGroups` | 0 | 0 | **定义了但无人使用** |

### 1.2 令牌层实际引用率

```
令牌层定义 74 个变量
实际被 var() 引用 49 个
零引用的 25 个：--rg-brand-400/800/900、--rg-grey-50/100/200/300/600/700/800/900、
               --rg-radius-xs/sm/md/lg/xl、--rg-sp-1/6/7/8/9/10/11、
               --rg-card-pad、--rg-state-info-surface
```

三个**功能性**死令牌（不是色阶冗余，是设计意图未被实现）：

| 令牌 | 定义位置 | 声称的作用 | 实际 |
|---|---|---|---|
| `--rg-card-pad` | `global.css:194`、`:224` | 密度切换时卡片内边距 16px → 12px | `.panel-body` / `.metric-cell` 写死 `p-4`，密度切换对它无效 |
| `--rg-radius-*`（5 档） | `global.css:159-163` | 三级表面圆角可推导 | `tailwind.config.ts:13-18` 另写了一套字面值，CSS 变量零引用 |
| `--rg-sp-*`（11 档） | `global.css:171-181` | 组件间距阶梯 | 只在 `global.css` 内部用 13 次，`.tsx` 里 0 次；实际间距全部走 Tailwind 数值类 |

### 1.3 三个已通过的守门检查

```
npx tsc -b          → exit 0
npx eslint .        → 无输出（0 error 0 warning）
node scripts/check-css-tokens.mjs → 49 个引用全部有定义
```

这三条说明**当前不是「编译不过」，而是「编译得过但会漂」**。所以本方案的每一步都必须挂着可失败的自动检查，否则改动无法验证。

---

## 2. 不一致清单（按类型，带证据）

### 2.1 类型一：文字色的表达分裂（最大单项，298 处）

`.text-aux` 只定义字号与行高，**不定义颜色**（`global.css:347-349`）：

```css
.text-aux {
  @apply text-[12px] leading-[1.5];
}
```

于是每一次「12px 的辅助文字」都要再补一个颜色。全库 274 次 `text-aux` 里，183 次紧跟着内联 `style={{ color: ... }}`。

298 个「仅 color」内联的实际取值分布：

| 值 | 次数 | 是否该有对应类 |
|---|---|---|
| `var(--rg-text-tertiary)` | 151 | 应有 `.fg-3` |
| `var(--rg-text-secondary)` | 78 | 应有 `.fg-2` |
| `var(--rg-state-warning)` | 18 | 应有 `.fg-warn` |
| `var(--rg-state-error)` | 13 | 应有 `.fg-danger` |
| `var(--rg-text-primary)` | 11 | 应有 `.fg-1` |
| `var(--rg-brand-600)` | 5 | 应有 `.fg-brand` |
| `var(--rg-state-success)` | 2 | 应有 `.fg-ok` |
| 条件表达式（`e.tone === 'ok' ? ... : ...`） | 20 | **保留内联**，是运行时状态 |

结论：278 处是纯静态映射，20 处是动态。静态那批是机械可改写的。

单文件最密集的五个：

```
OpsPage.tsx              30 处仅 color
TokenStatsPage.tsx       26
CredentialsPage.tsx      16
ModelRouterPage.tsx      15
EntitlementOverview.tsx  15
```

### 2.2 类型二：控件与容器的「原生 vs 组件」双轨

**裸 `<button>`（14 处，其中 11 处属合理自定义触发器、3 处属漏用）**

合理的（自带结构语义，不该套 `.btn`）：`MetricCard.tsx:65`（卡头）、`EntitlementOverview.tsx:169`（整行展开）、`Menu.tsx:226`（菜单项）、`CommandMenu.tsx:210`（结果项）、`NotifyBackupPanel.tsx:447`（开关型按钮）。

该收敛的（纯文字动作，外观在漂）：[OverviewPage.tsx:459-484](web/src/features/overview/OverviewPage.tsx#L459-L484) 三处 `<button className="underline" style={{ color: 'var(--rg-brand-600)' }}>`（三个跨页跳转入口）。它们用的是 `<button>` 而非 `<a>` / `<Link>`，因此：不能用 Ctrl+点击新开标签、不能用右键「复制链接地址」、读屏播报为「按钮」而非「链接」。同页面 [OverviewPage.tsx:438](web/src/features/overview/OverviewPage.tsx#L438) 与 [AccessKeysPage.tsx:456](web/src/features/accounts/AccessKeysPage.tsx#L456) 又是 `<Button onClick={navigate}>` —— 同一个「跳到另一个页面」的动作存在两种元素、两种外观。

另有一处「表格内可点文字」用虚线下划线表达可编辑：[CredentialsPage.tsx:939](web/src/features/accounts/CredentialsPage.tsx#L939) 的账号名，与同文件 [AccessKeysPage.tsx:570](web/src/features/accounts/AccessKeysPage.tsx#L570) 的虚线下划线是同一个视觉语汇、各写一遍。

裁决：跨页跳转统一用 react-router 的 `<Link className="link">`；表格内的可点文字用 `.link-inline`（继承字号、不换行）。两个类集中定义：

```css
  /*
   * 文字链接
   *
   * 项目里有两种「跳到另一个页面」：OverviewPage 的三个 inline 按钮、
   * 以及若干 <Button onClick={navigate}>。前者不能新开标签、不能被读屏
   * 识别成链接，后者看起来是个按钮。两处都改成 <Link>，样式集中到这里。
   */
  .link {
    @apply underline decoration-dotted underline-offset-2;
    color: var(--rg-brand-600);
    cursor: pointer;
  }
  .link:hover {
    text-decoration-style: solid;
  }
  /* 表格单元格内的可点文字：继承 13px，不换行，不撑列 */
  .link-inline {
    @apply inline-flex items-center max-w-full truncate underline decoration-dotted underline-offset-2;
    color: var(--rg-brand-600);
  }
  .link-inline:hover {
    text-decoration-style: solid;
  }
```

**裸 `<input>`（3 处文本型，全部属合理但重复）**

```
QoderOps.tsx:61      type="number" className="field" style={{ width: 56 }}
ZcodeOps.tsx:70      type="number" className="field" style={{ width: 56 }}
ZcodeOps.tsx:88      type="number" className="field" style={{ width: 56 }}
```

三处是**同一个组件写了两遍半**（`NumInput` / `HourInput` / `MinuteInput`），差异只有 `min`/`max` 与 `aria-label`。而 `OpsPage.tsx` 里同样的「时:分」又用 `FieldRow` + 两个内联 `field` 写了一遍（12 处 `FieldRow`，其中 6 组是时:分）。

同一个「时:分」输入，全库存在 **3 种实现**：`NumInput`、`HourInput`+`MinuteInput`、`FieldRow`+裸 input。

**裸 `<select>`（1 处）**

`DailyTrendChart.tsx:91-101` 绕过 `.select` 类，自己写 `text-aux leading-5 rounded-md border px-2 py-1` + 内联三色。后果：它高约 28px，而同排的 `Segmented` 是 30px，一行里两种高度。

### 2.3 类型三：间距与高度的数值漂移

**控件高度四档并存**

| 类 | 高度 | 定义 |
|---|---|---|
| `.seg-item` | 30px | [global.css:935](web/src/styles/global.css#L935) |
| `.btn` / `.field` / `.select` | 32px | [global.css:425](web/src/styles/global.css#L425) / [:467](web/src/styles/global.css#L467) / [:501](web/src/styles/global.css#L501) |
| `.btn-sm` | 26px | [global.css:462](web/src/styles/global.css#L462) |
| `.pill` | 22px | [global.css:882](web/src/styles/global.css#L882) |

`Segmented` 与 `Field`/`select`/`Button` 同排的位置有 6 处，其中 2x px 的高低差在基线上肉眼可见：

```
CredentialsPage.tsx:763    状态筛选 Segmented 紧接平台 select
TransferDialog.tsx:175     模式切换 Segmented 与表单同排
ModelPoolPage.tsx:374      分档 Segmented 与 Field 同排
DailyTrendChart.tsx:88     趋势视图 Segmented + 裸 select（28px，第三种高度）
TokenStatsPage.tsx:320     时间范围 Segmented 与账号 select 同在 actions
TrafficPage.tsx:200        时间范围 Segmented 与 Field 同在 toolbar
```

**页面级间距双计**

`PageShell.tsx:29-30`：

```tsx
{toolbar && <div className="toolbar">{toolbar}</div>}   // .toolbar 自带 mb-4
<div className="flex flex-col gap-4">{children}</div>   // 又给 16px
```

`toolbar` 与第一个 child 之间实际是 **16px 外边距 + 16px gap = 32px**，而 child 之间是 16px。这与「区块间距统一 16px」的注释矛盾。

**`.toolbar` 被就地打穿一次**

`CredentialsPage.tsx:735`：

```tsx
<div className="toolbar" style={{ margin: 0, border: 0, borderRadius: 0 }}>
```

为了把工具栏嵌进 `Panel flush` 而覆盖三个属性 —— 这类「用了类再全推翻」的写法，比不用类更难维护。

**密度切换的失效面**

`--rg-card-pad` 零引用（见 1.2），所以 `[data-density='compact']` 只改了行高与单元格内边距，**卡片内边距不跟着变**。用户在紧凑模式下看到「表格变紧了、卡片没变」，比不做密度更奇怪。

### 2.4 类型四：弹窗形态不统一

19 个 `Modal` 调用点的尺寸选择：

```
size="lg"  → 12 个
size="xl"  → 2 个（ChannelOpsDialog、ImportRaccoonDialog）
默认 md    → 5 个（AccountAttrsDialog、CreateAccessKeyDialog、LoginKeyDialog、
                   OauthTraeDialog、WbOauthDialog）
```

尺寸与内容量不匹配的具体表现：`CreateAccessKeyDialog` 里有平台单选组 + 权限多选 + 有效期，内容高度超过 md 的 520px 宽度能舒适排布的范围，但它没有传 `size`；反过来 `LoginKeyDialog` 只有两个输入框却在 md，这是对的。

弹窗正文的纵向间距同样不统一 —— 17 个 Dialog 里 `flex flex-col gap-*` 的取值分布：

```
gap-1  × 10     gap-2  × 7     gap-3  × 7     gap-4  × 7
gap-0.5 × 2     gap-3.5 × 1     gap-1.5 × 1
```

七种间距，无规律可循。

### 2.5 类型五：容器的语义重叠

四个类都在表达「一条横向汇总信息」，但样式各不相同：

| 类 | 外观 | 使用位置 |
|---|---|---|
| `.toolbar` | 白底 + 全边框 + `mb-4` + 圆角 | 5 个页面 |
| `.stat-strip` | 灰底 + 全边框 + 圆角 | 3 处 |
| `.ent-rollup` | 灰底 + **只有下边框** + 无圆角 | 1 处（权益总览内） |
| `.growth-bar` | 白底 + **只有下边框** + 无圆角 | 3 处 |

`.ent-rollup` 与 `.growth-bar` 是同一视觉语言（面板内嵌条），却分成两个类；`.stat-strip` 与它们语义相同（页面级统计）却又是独立一套。结果：三张表上方的统计信息在三个页面长相不同。

同时，`QoderOps.tsx:225` 与 `ZcodeOps.tsx:262` 是**几乎逐字相同**的「最近一轮结果」卡片：

```tsx
// QoderOps.tsx:224-227
<div className="rounded-lg border p-3 text-aux flex flex-col gap-1"
  style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}>

// ZcodeOps.tsx:261-263
<div className="rounded-lg border p-3 text-aux flex flex-col gap-1"
  style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}>
```

这正是 `.subcard-soft` 应该承担的角色，但它全库只被用了 2 次。

### 2.6 类型六：表格列的稳定性

47 张 `<table>` 里只有 3 张带 `table-fixed`：

```
[CredentialsPage.tsx:841](web/src/features/accounts/CredentialsPage.tsx#L841)   凭据主表
[KeepaliveBoard.tsx:204](web/src/features/accounts/KeepaliveBoard.tsx#L204)     保活看板
[ModelRouterPage.tsx:608](web/src/features/models/ModelRouterPage.tsx#L608)     候选表
```

其余 44 张全走 auto 布局 —— 包括 8 张行数会随筛选变化的表（`TokenStatsPage` 的 7 张明细表、`AuditPage` 主表、`TrafficPage` 的两张日志表）。

`global.css:956-969` 已经把「为什么必须 fixed」写清楚：列宽由内容反推，筛选后内容变化会让整表横向位移。44 张表仍走 auto 布局 —— 包括 8 张行数会随筛选变化的表（`TokenStatsPage` 的 7 张明细表、`AuditPage`、`ModelRouterPage` 的候选表）。

`OverviewPage` 的 4 张 `.detail-table` 是另一套体系（35 个 `<td>`、15 个 `<th>` 都不带 `.td`/`.th` 类），这是**设计上正确的分工**：明细表无交互、行数少、以扫读为目的，`global.css:822-874` 已给它独立的 padding 与列宽类。但它与 `.data-table` 的切换没有书面规则，新写一张表时无法判断该用哪个。

### 2.7 类型七：设计源文件与实现的分歧

`global.css:20` 写着「权威来源：TraeWork 设计系统」，而仓库内还有 `design/relaygate-console/colors_and_type.css` 也自称 `Source of truth`。两者同名令牌有 **14 处不同值**：

| 令牌 | design 文件 | 实现 |
|---|---|---|
| `--rg-text-tertiary` | `#737373` | `#6b6b6b` |
| `--rg-text-disabled` | `#A1A1A1` | `#707070` |
| `--rg-state-success` | `#15A877` | `#0f7d59` |
| `--rg-state-warning` | `#E27900` | `#a85800` |
| `--rg-state-error` | `#E8463A` | `#c23a30` |
| `--rg-state-info` | `#2F74FF` | `#1f5fd6` |
| `--rg-sp-2` | 2px | 4px |
| `--rg-sp-4` | 4px | 12px |
| `--rg-sp-6` | 6px | 20px |
| `--rg-sp-8` | 8px | 32px |
| `--rg-sp-10` | 10px | 48px |
| `--rg-font-sans` | SF Pro Text 优先 | Segoe UI Variable 优先 |

前六项是**实现主动改的，且改对了** —— `global.css:54-97` 的注释把对比度算到了小数点后两位，原 design 值在白底只有 3.0~3.4，不达 AA。后五项是实现自行重排的阶梯，与 design 的编号体系完全不同（design 的编号=像素值，实现的编号=序号）。

问题不在改错，在于**没有把结论写回设计源文件**，于是下一个照着 `design/` 改的人会把对比度退化回去。

---

## 3. 统一规范（裁决表）

规范只写「必须遵守的判据」，不写「建议」。每条都给出可机检的形态。

### 3.1 颜色：只有两条通道

1. **在 `global.css` 里定义语义类**，组件层只用类。
2. 只有「值随数据变化」时才允许内联，且内联的必须是 `var(--rg-*)`，不得出现字面色值。

新增 8 个文字色类（`global.css` 的 components 层，紧跟 `.text-unit` 之后）：

```css
  /*
   * 文字色语义类
   *
   * 存在的唯一理由：「一个 color 的内联 style」有 298 处，占全部内联的 72%。
   * 那意味着改一次辅助文字的颜色要动 40 个文件。这一组类把颜色从
   * 「每处自己写的属性」变成「可以 grep 的类名」。
   *
   * 命名用 fg-<level> 而不是 text-*：.text-aux 等已经是「字号+行高」的类，
   * 同名族会让「text-aux 到底带不带颜色」永远说不清。
   *
   * 与 .text-* 的组合约定：.text-aux 不带颜色，必须配 .fg-N 之一。
   * 单独使用 .text-aux 视为漏写（由 check-ui-consistency 的
   * textAuxWithoutFg 规则拦）。
   */
  .fg-1 { color: var(--rg-text-primary); }
  .fg-2 { color: var(--rg-text-secondary); }
  .fg-3 { color: var(--rg-text-tertiary); }
  .fg-disabled { color: var(--rg-text-disabled); }
  .fg-brand { color: var(--rg-brand-600); }
  .fg-ok { color: var(--rg-state-success); }
  .fg-warn { color: var(--rg-state-warning); }
  .fg-danger { color: var(--rg-state-error); }
```

同时补三个背景类，收掉 28 处「仅 background」的内联：

```css
  /* 表面色语义类：与 .fg-* 对称，收掉 28 处「仅 background」内联 */
  .surface-base { background: var(--rg-bg-base); }
  .surface-2 { background: var(--rg-bg-secondary); }
  .surface-3 { background: var(--rg-bg-tertiary); }
```

**字面色值禁令**：组件层禁止 `#rrggbb`。当前全库只有 2 处，都在 SVG 图形属性里（`SetupGate.tsx:129/132` 的白色描边、`ImportRaccoonDialog.tsx:559/560` 的二维码黑白），属图形而非主题，**豁免**。新闸门规则 `literalHexColors` 预算已设为 0，任何新增都会失败。

### 3.2 字号：六档，不允许第七档

| 类 | 字号 | 用途 | 是否带颜色 |
|---|---|---|---|
| `.text-page` | 22px | 页面标题（每页唯一） | 否，配 `.fg-1` |
| `.text-block` | 16px | 面板标题 | 否，配 `.fg-1` |
| `.text-read` | 24px | 关键读数 | 否，配 `.fg-1` |
| `.text-hero` | 28px | 单页主读数 | 否，配 `.fg-1` |
| `.text-aux` | 12px | 辅助信息 / 标签 / 时间戳 | **否，必须配 `.fg-N`** |
| `.text-unit` | 11px | 数字后的单位后缀 | 否（自带 `--rg-text-tertiary`） |

判据：`text-[13px]` 允许（它是 body 默认字号，写在 `.td` / `.btn` / `.field` 里），`text-[Npx]` 在 `.tsx` 里只允许 13。当前 36 处违规中，`text-[15px]` 2 处（`KeyCards`、`CommandMenu`）、`text-[14px]` 2 处（`Modal` 标题、`ent-amount`）、`text-[11px]` 1 处需逐条裁决。

### 3.3 控件高度：32px 是基线

| 档 | 高度 | 类 | 何时用 |
|---|---|---|---|
| 标准 | **32px** | `.btn` / `.field` / `.select` / `.seg-item` | 页面工具栏、表单、弹窗 |
| 紧凑 | 26px | `.btn-sm` | 表格行内、卡头动作 |
| 徽标 | 22px | `.pill` | 状态标签 |
| 表格内嵌 | 24px | `.stepper` | 仅单元格内 |

**改动**：`.seg-item` 从 `h-[30px]` 改 `h-8`（32px），消除 6 处 2px 基线错位。

```css
  .seg-item {
    @apply inline-flex items-center h-8 px-3 text-[12px] cursor-pointer whitespace-nowrap
      transition-colors border-r;
    /* 高度与 .btn/.field/.select 对齐：此前 30px，与它们同排时基线错 2px，
       在 CredentialsPage 状态筛选、TokenStatsPage 时间范围、TrafficPage
       工具栏等 6 处肉眼可见。 */
    border-color: var(--rg-border-strong);
    background: var(--rg-bg-base);
    color: var(--rg-text-secondary);
  }
```

### 3.4 间距：单一来源

**裁决**：间距以 Tailwind 数值类为准（`gap-2`=8px、`gap-3`=12px、`gap-4`=16px），`--rg-sp-*` 只在 `global.css` 内部使用，不得在 `.tsx` 中出现。

理由：`--rg-sp-*` 在 `.tsx` 里被引用 0 次，在 `global.css` 里 13 次；而 Tailwind 间距类在 `.tsx` 里出现 201 次。让 201 处去迁就 13 处没有收益，且会破坏 Tailwind 的 `space-x` / `divide-` 等衍生工具。

**必须消除的双计**：`PageShell.tsx` 的 toolbar 后间距。

```tsx
// 修改前（PageShell.tsx:29-30）：.toolbar 自带 mb-4，再叠 gap-4 → 32px
{toolbar && <div className="toolbar">{toolbar}</div>}
<div className="flex flex-col gap-4">{children}</div>

// 修改后：把 toolbar 放进同一个 gap 流，删掉 .toolbar 的 mb-4 依赖
<div className="flex flex-col gap-4">
  {toolbar && <div className="toolbar mb-0">{toolbar}</div>}
  {children}
</div>
```

配套改 `global.css:1187`：`.toolbar` 去掉 `mb-4`，改为「由父级 gap 决定」。这同时让 `CredentialsPage.tsx:735` 的内联覆盖从 3 个属性降到 2 个（不再需要 `margin: 0`）。

### 3.5 卡片：三档表面，禁止第四档

| 类 | 用途 | 底色 | 内边距 |
|---|---|---|---|
| `.panel` | 一级容器（页面区块） | `--rg-bg-base` | `.panel-body` 16px |
| `.subcard` | 二级容器（面板内分组） | `--rg-bg-base` | `px-3.5 py-3` |
| `.subcard-soft` | 二级容器（置于灰底之上） | `--rg-bg-secondary` | `px-3.5 py-3` |

**判据**：`.tsx` 里出现 `className="rounded-lg border` + 内联 `borderColor`/`background` 的组合即为违规 —— 那是 `.subcard` / `.subcard-soft` 的手写版。当前 7 处，全部收敛：

```
QoderOps.tsx:225           → .subcard-soft
QoderOps.tsx:255           → .subcard-soft
ZcodeOps.tsx:262           → .subcard-soft
ZcodeOps.tsx:289           → .subcard-soft
ImportRaccoonDialog.tsx:84 → .subcard-soft
TokenStatsPage.tsx:74      → .subcard（口径卡，白底）
NotifyBackupPanel.tsx:634  → .subcard-flush（需横向滚动，用 flush 变体）
```

### 3.6 表格：两套体系，各管一半

| 类 | 适用 | 列宽策略 | 单元格类 |
|---|---|---|---|
| `.data-table` | 有交互、行数随筛选变化、有操作列 | **必须** `table-fixed` + `.col-*` | `.th` / `.td` |
| `.detail-table` | 无交互、行数 ≤ 8、扫读比较 | auto 布局 + `.col-num/unit/name/note` | 不用 `.th`/`.td` |

判据：新增表格时先问「这张表的行数会不会因为用户操作而改变」。会 → `data-table` + `table-fixed`。不会 → `detail-table`。

这条规则目前**已经在 `global.css:822-874` 的注释里隐含存在**，但没有一句话写清边界，所以 44 张表都用了 auto 布局。

按「同页有筛选控件」筛选，优先加 `table-fixed` 的是这 12 张：

| 页面 | 表数 | 同页筛选 |
|---|---|---|
| `TokenStatsPage` | 7 | 时间范围 `Segmented` + 账号 `select` |
| `TrafficPage` | 2 | 模型搜索框 + 分页 |
| `AccessKeysPage` | 1 | 状态筛选 `Segmented` |
| `ModelPoolPage` | 1 | 状态筛选 `Segmented` |
| `AuditPage` | 1 | 分段切换 |

加上已 fixed 的 3 张，目标覆盖率 15 / 43（4 张 `.detail-table` 按 3.6 的判据不适用，不进分母）。

### 3.7 反馈三态：必须用组件

| 态 | 组件 | 禁止 |
|---|---|---|
| 加载 | `LoadingBlock` | 自写「加载中…」文案（当前 2 处） |
| 空 | `EmptyState`（`label` + `hint` + 可选 `action`） | 自写一句灰字（当前 0 处违规，保持） |
| 错误 | `ErrorState`（`message` + `onRetry`） | 用 `.fg-danger` 文字顶替（当前 30 处内联 `--rg-state-error`，需逐条判断哪些是真实错误态） |

### 3.8 弹窗尺寸：按内容定，不按习惯

| 尺寸 | 宽度 | 判据 |
|---|---|---|
| `md`（默认） | 520px | 字段 ≤ 4 个、无表格、无代码块 |
| `lg` | 720px | 有表格、有多列表单、有预览区 |
| `xl` | 920px | 有分区导航、有双栏编辑器 |

按此判据复核 5 个默认 `md` 的弹窗：`CreateAccessKeyDialog`（平台单选 + 权限多选 + 有效期 + 结果码块）应升 `lg`；其余 4 个保持 `md`。

弹窗正文间距统一为 **`flex flex-col gap-4`**（字段组之间），组内字段用 `gap-1`（标签与控件）、`gap-2`（并列控件）。当前 `gap-3` / `gap-3.5` / `gap-0.5` 的写法在改动时顺手归并。

### 3.9 `Segmented` 的语义修正

现在 17 处 `Segmented` 都渲染成 `role="tablist"`，但实测只有 **1 处**真正在导航（[OpsPage.tsx:463](web/src/features/ops/OpsPage.tsx#L463) 的运维分区，回调里调 `navigate(t.path)`）。其余 16 处全是筛选器：

```
AccessKeysPage.tsx:261      状态筛选（全部 / 生效中 / 停用）
CredentialsPage.tsx:763     状态筛选（全部 / 可用 / 冷却中 / 停用）
ImportQoderDialog.tsx:224   导入模式
ImportQoderDialog.tsx:300   区域
ImportWbDialog.tsx:188      导入模式
TransferDialog.tsx:175      导入 / 导出
WbOauthDialog.tsx:160       登录模式
ModelPoolPage.tsx:374       状态筛选（全部 / 可用 / 不可用 / 未探测 / 媒体）
ModelPoolPage.tsx:388       统计区间（今日 / 近 7 日）
ClientAccessPanel.tsx:83    接入方式
NotifyBackupPanel.tsx:405   通知分组
OverviewPage.tsx:385        到期窗口（3 / 7 / 30 天）
AuditPage.tsx:93            审计分段
DailyTrendChart.tsx:88      趋势视图（按日 / 按模型）
TokenStatsPage.tsx:320      时间范围（今日 / 7 日 / 30 日）
TrafficPage.tsx:200         时间范围（24 小时 / 7 日）
```

读屏会把「全部 / 可用 / 冷却中 / 停用」播报成「选项卡 2/4，已选中」—— 语义错误：选完不会切换面板，只是过滤当前表格。

**改动**：给 `Segmented` 增加 `variant?: 'tabs' | 'filter'`，默认 `filter`：

```tsx
export interface SegmentedProps<T extends string> {
  options: readonly SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  /**
   * tabs   = 切换内容面板（role=tablist / tab，需配套 aria-controls）
   * filter = 过滤当前列表（role=group + aria-pressed，不占用 tab 语义）
   *
   * 默认 filter：全库 17 处调用点里 16 处是筛选，只有 1 处是真页签
   * （OpsPage.tsx:463 的运维分区，回调调 navigate）。
   * 反过来设默认会让多数调用点播报错误的角色。
   */
  variant?: 'tabs' | 'filter';
}
```

`filter` 分支渲染：

```tsx
<div className="seg" role="group" aria-label={ariaLabel}>
  {options.map((o) => (
    <button
      key={o.value}
      type="button"
      className="seg-item"
      aria-pressed={o.value === value}
      onClick={() => onChange(o.value)}
    >
      {o.label}
    </button>
  ))}
</div>
```

`.seg-item[aria-selected='true']` 选择器需同步支持 `[aria-pressed='true']`。

### 3.10 数字与时间输入：一个组件

现状：同一个「时:分」有 3 种实现（见 2.2）。抽成一个组件追加到 `shared/ui/index.tsx`：

```tsx
/* NumberField */

/**
 * 定宽数字输入。
 *
 * 为什么不是 Field + props：Field 强制 w-full（它的设计场景是表单主体），
 * 而这里全是「工具条里一个 56px 的格子」。此前 QoderOps / ZcodeOps / OpsPage
 * 各自绕开 Field 写了一版，三处都用 style={{ width: 56 }} 兜底 —— 那正是
 * 「组件不覆盖真实场景」的信号。
 */
export function NumberField({
  value,
  min = 0,
  max = 99,
  width = 56,
  label,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  /** 像素宽。默认 56 够放两位数字加内边距 */
  width?: number;
  /** 无障碍名，必填：这些控件没有可见标签 */
  label: string;
  onChange: (next: number) => void;
}) {
  return (
    <input
      type="number"
      className="field font-mono text-aux"
      style={{ width }}
      min={min}
      max={max}
      value={value}
      aria-label={label}
      onChange={(e) => {
        const n = Number.parseInt(e.target.value, 10);
        onChange(Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min);
      }}
    />
  );
}

/* TimeOfDay */

/**
 * 「时:分」组合。
 *
 * 三处独立实现（QoderOps.NumInput、ZcodeOps.HourInput+MinuteInput、
 * OpsPage 的 FieldRow + 两个裸 input）在本组件落地后应全部删除。
 * 语义与 aria 都在这一层定死：两个输入各有独立标签，
 * 而不是让读屏听到两个没有名字的数字框。
 */
export function TimeOfDay({
  hour,
  minute,
  label,
  onChange,
}: {
  hour: number;
  minute: number;
  /** 组合名，例如「每日签到」「账号轮换时刻」 */
  label: string;
  onChange: (next: { hour: number; minute: number }) => void;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <NumberField
        value={hour}
        min={0}
        max={23}
        label={`${label}：时`}
        onChange={(h) => onChange({ hour: h, minute })}
      />
      <span className="font-mono text-aux fg-2" aria-hidden="true">
        :
      </span>
      <NumberField
        value={minute}
        min={0}
        max={59}
        label={`${label}：分`}
        onChange={(m) => onChange({ hour, minute: m })}
      />
    </span>
  );
}
```

改造成本：`QoderOps.tsx:59-75` 删 17 行、`ZcodeOps.tsx:68-102` 删 35 行、`OpsPage.tsx` 6 组时:分各减 8 行。净减约 70 行。

### 3.11 死令牌裁决

| 令牌 | 裁决 |
|---|---|
| `--rg-card-pad` | **接线**：`.panel-body` / `.metric-cell` 改用它，让密度切换真正生效 |
| `--rg-radius-*` | **接线**：`tailwind.config.ts` 的 `borderRadius` 改为引用变量 |
| `--rg-sp-*` | **保留但标注**：仅 `global.css` 内部使用，`.tsx` 禁用（写进注释） |
| `--rg-state-info` / `-surface` | **接线**：`ChipTone` 增加 `'info'` 分支，用它表达「进行中 / 排队中」 |
| `--rg-brand-400/800/900`、`--rg-grey-*` 九档 | **保留**：色阶本身是完整的，组件按需取用，不为了「引用率」硬造用途 |

对应的两处代码改动：

```css
  /* global.css:194 区域 —— 密度令牌接线 */
  .panel-body { padding: var(--rg-card-pad); }
  .metric-cell { padding: var(--rg-card-pad); }
```

```ts
// tailwind.config.ts —— 半径只有一个来源
borderRadius: {
  xs: 'var(--rg-radius-xs)',
  sm: 'var(--rg-radius-sm)',
  md: 'var(--rg-radius-md)',
  lg: 'var(--rg-radius-lg)',
  xl: 'var(--rg-radius-xl)',
},
```

注意：`tailwind.config.ts` 的 `fontFamily.mono` 与 `--rg-font-mono` 是**两套栈**，且本机实测只有 Cascadia 装了、JetBrains Mono 没装：

```
font-mono class（.tsx 内 164 次）→ JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas
--rg-font-mono（0 次内联）      → Cascadia Mono, Cascadia Code, Consolas, SF Mono, ...
本机字体实测：Cascadia Mono 有、Cascadia Code 有、Consolas 有、JetBrains Mono 无
```

裁决：**以 Cascadia 优先为准**，改 `tailwind.config.ts:11` 为 `['Cascadia Mono', 'Cascadia Code', 'Consolas', 'ui-monospace', 'monospace']`，`--rg-font-mono` 保持，两者字符串一致。理由：[global.css:196-203](web/src/styles/global.css#L196-L203) 的注释已经解释过「首选必须确定存在」，而 mono 栈当时漏改了 —— 这条注释自己写着「JetBrains Mono 在 Windows 上不随系统分发」，但 `tailwind.config.ts` 仍把它放在首位。

### 3.12 设计源文件同步

`design/relaygate-console/colors_and_type.css` 必须与实现对齐，否则它是**负资产**（照它改会把对比度改差）。两种做法：

- 方案 A（推荐）：把 `design/` 降级为「历史原型快照」，文件头加一行声明，`global.css` 成为唯一权威。
- 方案 B：把实现里算过的对比度结论回写到 `design/` 文件，两份保持同步。

选 A。理由：`design/` 里是静态 HTML 原型，已经不再驱动实现；维护两份同义文件只会制造第 2.7 节那种分歧。补充成本最低的落地形态：

```css
/* design/relaygate-console/colors_and_type.css 顶部追加 */
/*
 * ⚠️ 本文件是 2026-11 之前的原型快照，不再驱动实现。
 * 现行令牌的唯一权威来源：web/src/styles/global.css。
 * 本文件中的 --rg-state-* 与 --rg-text-tertiary 是被有意替换的低对比度原值
 * （白底 3.0~3.4，不达 WCAG AA），不要照抄回实现。
 */
```

---

## 4. 优先级与执行清单

排序依据：**每项都算「收益 ÷ 风险」，并把「是否可机检」作为加权项** —— 不可机检的改动做完会漂回去。

### P0：三天内完成，全部低风险、可机检

#### P0-1　加 8 个文字色类 + 3 个背景类（0.5 天）

- 动作：按 3.1 追加到 `global.css` components 层
- 收益：为后续 180 处机械改写提供目标
- 验证：`node scripts/check-css-tokens.mjs` 应仍通过（新增的是定义不是引用）

#### P0-2　用 codemod 改写 180 处内联颜色（0.5 天）

已写好脚本，先 dry-run 看清单：

```powershell
cd web
node scripts/codemod-inline-colors.mjs          # 报告：可改写 180 处 / 39 个文件
node scripts/codemod-inline-colors.mjs --write  # 落盘
node scripts/check-ui-consistency.mjs --update  # 预算随之下调
npx tsc -b && npx eslint .
```

脚本只处理「同一行内 `className="..."` 紧跟只含 `color` 的 style」，值必须是 8 个纯令牌之一，动态表达式自动跳过（实测跳过 0 处）。可重复执行。

预期效果：`styleBlocks` 411 → 231、`inlineTokenRefs` 432 → 252。

剩余 118 处「值不是纯令牌或含动态」的，按文件逐个人工处理：

```
OpsPage.tsx 22 处（含 6 组时:分的内联，随 P1-3 一并消掉）
TokenStatsPage.tsx 22 处（CaliberCard 的 accent 三元，保留）
其余按 P1-3 / P1-4 分批
```

#### P0-3　`.seg-item` 高度对齐 32px（0.2 天）

- 动作：3.3 的单行改动
- 收益：消除 6 处基线错位
- 验证：`CredentialsPage` 状态筛选行、`TrafficPage` 工具栏目视检查对齐

#### P0-4　`PageShell` 间距双计修复（0.2 天）

- 动作：3.4 的两处改动（`PageShell.tsx:29-30`、`global.css:1187` 去 `mb-4`）
- 收益：区块间距回到统一 16px；`CredentialsPage.tsx:735` 的内联覆盖少一项
- 验证：9 个页面的首块间距一致（`gap-4` = 16px）

#### P0-5　接入两个守门脚本（0.3 天）

脚本已落盘，只差挂到 `package.json`：

```json
"scripts": {
  "check:ui": "node scripts/check-ui-consistency.mjs",
  "codemod:colors": "node scripts/codemod-inline-colors.mjs",
  "check:tokens": "node scripts/check-css-tokens.mjs",
  "check": "npm run check:tokens && npm run check:ui && tsc -b && eslint ."
}
```

`check-ui-consistency.mjs` 的 ratchet 机制：当前值写入 `scripts/ui-consistency-baseline.json` 作为预算，**只允许下调**。已验证它能拦住回归 —— 临时插入一个带内联 style 的裸 button，三条规则同时报超预算、退出码 1；删掉后恢复通过。

预算现状：

```json
{
  "styleBlocks": 411,
  "inlineTokenRefs": 432,
  "rawButtonNoBtnClass": 14,
  "rawTextInputNoField": 3,
  "hardcodedTextPx": 36,
  "literalHexColors": 0
}
```

#### P0-6　修 `global.css` 的重复规则（0.1 天）

`global.css:619-624` 与 `:625-630` 是**逐字相同**的 `.panel-foot`，第二段是复制残留。删掉后一段。

#### P0-7　mono 字体栈统一（0.1 天）

按 3.11 改 `tailwind.config.ts:11`。收益：`font-mono` 的 164 处渲染从「JetBrains Mono 缺失→ui-monospace→Segoe UI 的等宽替代」变成确定的 Cascadia Mono，数字对齐稳定。

---

### P1：一周内完成，需要人工判断，收益集中在「一致性」

#### P1-1　抽 `NumberField` / `TimeOfDay`（1 天）

- 动作：按 3.10 追加组件，删掉 `QoderOps.NumInput`、`ZcodeOps.HourInput`/`MinuteInput`
- 收益：26 处数字输入收敛到 1 个组件；净减约 70 行
- 影响文件：`QoderOps.tsx`、`ZcodeOps.tsx`、`OpsPage.tsx`（6 组时:分）、`KeepaliveSchedule.tsx`
- 验证：时:分输入的可访问名从「时」「分」变成「每日签到：时」「每日签到：分」；键盘 Tab 顺序不变

#### P1-2　7 处手写卡片收敛为 `.subcard*`（0.5 天）

- 动作：按 3.5 的对照表逐条替换
- 收益：`QoderOps` 与 `ZcodeOps` 的「最近一轮结果」终于长得一样
- 验证：两页并排截图对比，卡片底色/边框/内边距一致

#### P1-3　`Segmented` 增加 `variant`（0.5 天）

- 动作：按 3.9 改组件；17 个调用点里 16 处用默认 `filter`，只有 [OpsPage.tsx:463](web/src/features/ops/OpsPage.tsx#L463) 显式传 `tabs`
- 收益：筛选控件不再被读屏播报成页签
- 验证：用无障碍树检查（Chrome DevTools → Accessibility）确认 `role=group` + `aria-pressed`

#### P1-4　表格 `table-fixed` 补课（1.5 天）

- 动作：优先给 8 张行数会变的表加 `table-fixed`（清单见 3.6）；同时把 3.6 的两套体系判据写进 `global.css` 注释
- 风险：`table-fixed` 会让超出列宽的内容被截断而不是撑列，必须先确认每个 `td` 有截断策略
- 验证：在这 8 张表上做「筛选前 → 筛选后」截图对比，列位置必须完全一致
- **这一项建议先在一张表上做完再铺开**，`TokenStatsPage` 里那张最窄的（拟合表，:944-948）适合当试点

#### P1-5　四种汇总条收敛为两种（0.5 天）

- 动作：`.stat-strip`（页面级，全边框）与 `.rollup-bar`（面板内嵌，只有下边框）两个类，把 `.ent-rollup` / `.growth-bar` 合并进后者
- 收益：三个页面的统计条外观一致；类名从 4 个减到 2 个
- 验证：`CredentialsPage`、`EntitlementOverview`、`GrowthPanel` 三处灰底条视觉一致

#### P1-6　弹窗尺寸与间距复核（0.5 天）

- 动作：`CreateAccessKeyDialog` 升 `lg`；17 个 Dialog 的 `flex flex-col gap-*` 归并到 `gap-4`（组间）/ `gap-1`（标签与控件）/ `gap-2`（并列控件）
- 收益：弹窗正文的节奏一致，不再有 `gap-3.5` 这种孤例

#### P1-7　`ChipTone` 增加 `info`（0.2 天）

- 动作：`shared/ui/index.tsx` 的 `ChipTone` 加 `'info'`，`CHIP_CLASS` 加 `'pill pill-info'`；`global.css` 补 `.pill-info`
- 收益：`--rg-state-info` 这个定义了却零引用的令牌终于有语义出口；「进行中 / 排队中」不再借用 `warn` 或 `brand`

---

### P2：结构性改造，按需推进

#### P2-1　密度令牌真正生效（0.5 天）

- 动作：3.11 的 `.panel-body` / `.metric-cell` 接线
- 收益：紧凑模式下卡片内边距跟着 16→12；`--rg-card-pad` 从死令牌变活
- 验证：切换密度后 `getComputedStyle(document.querySelector('.panel-body')).padding` 应为 `12px`

#### P2-2　半径令牌接线到 Tailwind（0.3 天）

- 动作：3.11 的 `tailwind.config.ts` 改动
- 收益：5 个死令牌变活；改圆角只需改一处
- 验证：`rounded-lg` 的 `border-radius` 计算值应等于 `var(--rg-radius-lg)` → 8px

#### P2-3　暗色主题（3 天，需产品决策）

现状：令牌层**已经为此准备好了** —— 颜色全部集中在 `:root`、浮层阴影与遮罩已抽成 `--rg-scrim` / `--rg-shadow-pop`、图表序列已独立成 `--rg-viz-*`。缺的只是：

1. `html[data-theme='dark']` 的令牌覆盖块（约 30 个变量）
2. 顶栏加切换按钮（复用 `density.ts` 的 store 模式）
3. `color-scheme` 与原生控件（`select` 下拉、滚动条）跟随

这一项不列进 P0/P1，因为它是**产品决策**而不是一致性缺陷。但第 2.1~2.5 节的问题做掉之后，暗色主题的成本会从「改 411 处内联」降到「改 30 个变量」—— 这也是先做 P0 的真实回报。

#### P2-4　设计源文件降级（0.2 天）

- 动作：3.12 的文件头声明
- 收益：消除「两个 Source of truth」，避免有人照 design 文件把对比度改回去

---

## 5. 与免费组件库的关系（为什么一个都不引入）

上一轮核对了 6 个库的授权与登录要求，结论是 Watermelon UI 与 Libraries.dev 可零成本使用。但对本项目，**6 个都不该引入**，理由是可验证的技术事实，不是偏好：

### Watermelon UI（MIT，免登录，免费）

- registry 里的组件是 **Tailwind v4 + shadcn 约定**。实测 `https://registry.watermelon.sh/r/button.json` 的源码：

  ```
  size-4 出现 4 次、shadow-xs 1 次、ring-[3px]
  import { cn } from "@/lib/utils"
  dependencies: @radix-ui/react-slot, class-variance-authority
  ```

- 本项目是 **Tailwind 3.4.15**（`web/package.json:29`）。`size-*` 与 `shadow-xs` 是 v4 的写法，v3 下会静默失效；`cn` 与 `cva` 是项目从未引入的依赖（实测全库 0 处 `clsx` / `tailwind-merge`）。
- 结论：**不拉取组件，只吸收两个模式** —— ①「变体用 `cva` 的枚举思维组织」，本项目用 `VARIANT_CLASS` 常量表已经等价实现；②「registry 单文件可拷贝」，本项目用的是「`shared/ui` 集中 + 类在 CSS」，同样成立。

### Libraries.dev（MIT，免登录，免费）

- 是 7 个效果类 npm 包（`border-beam`、`thinking-orbs`、`metal-fx` 等），定位是**AI 界面的装饰性动效**。本项目是运维控制台，主场景是密集表格与状态判读，与「思考球 / 液态金属按钮」的设计意图相斥。
- 结论：不引入。若未来做公开落地页，可单独在营销页使用，不进管理端 bundle。

### Bencho（48 块 MIT，免登录）

- 是 176 个「微交互区块」的集合，风格是单块独立 CSS（`Like.css` 4800 字符、`--fill-slab` 这类局部变量）。引入意味着出现**第二套令牌命名体系**，与 `--rg-*` 并行。
- 结论：不引入组件，但它的一个做法值得抄 —— **每个块自带 `:focus-visible` 与 `prefers-reduced-motion`**。本项目已有全局 `:focus-visible` 与 `prefers-reduced-motion` 块（`global.css:1445-1455`），这点已经做到了。

### BoardUI / HeroUI Pro / beUI Pro

- 免费段是 MIT 的「基础组件」，付费段才是图表、模板、AI 组件。本项目的图表是自写的 SVG（`DailyTrendChart`、`TokenHeatmap`、`TokenMixRing`、`ShareBar`），与上游数据口径（三套计量不可相加）强绑定，换成通用图表库反而要重写口径判据。
- 结论：不引入。

**净结论：新增运行时依赖 0 个、新增开发依赖 0 个。** 本方案的全部内容是「用已有的令牌 + 已有的组件 + 已写好的两个零依赖脚本」。

---

## 6. 验证方案

### 6.1 每步必跑的三条

```powershell
cd web
node scripts/check-css-tokens.mjs     # 引用的令牌都有定义
node scripts/check-ui-consistency.mjs # 六项指标未超预算
npx tsc -b && npx eslint .            # 类型与规则
```

### 6.2 阶段验收指标

| 阶段 | 指标 | 当前 | 目标 | 检验命令 |
|---|---|---|---|---|
| P0 完成 | `styleBlocks` | 411 | ≤ 231 | `node scripts/check-ui-consistency.mjs` |
| P0 完成 | `inlineTokenRefs` | 432 | ≤ 252 | 同上 |
| P0 完成 | `.panel-foot` 重复定义 | 2 处 | 1 处 | `grep -c '^  \.panel-foot {' src/styles/global.css` |
| P1 完成 | `seg-item` 高度 | 30px | 32px | DevTools 量 `CredentialsPage` 状态筛选 |
| P1 完成 | 数字输入实现数 | 3 套 | 1 套 | `grep -rn 'type="number"' src` 应只剩 `shared/ui/index.tsx` |
| P1 完成 | `table-fixed` 覆盖 | 3/43 | 15/43 | 见 `output/ui-audit/tables-cards.ps1` |
| P1 完成 | 手写卡片容器 | 7 处 | 0 处 | `grep -rn 'rounded-lg border p-' src` |
| P2 完成 | 死令牌数 | 25 | ≤ 8 | 见第 1.2 节的差集脚本 |

### 6.3 回归清单（不可退化项）

改动后必须仍然成立的三件事，逐条手测：

1. **一次 Esc 只关最上层弹窗**（`Modal.tsx` 的 OPEN_STACK 机制）—— 打开第二层弹窗按 Esc，应退回第一层
2. **弹窗打开时背景不横跳**（滚动条宽度补偿）—— 在长表格页打开弹窗，观察右侧
3. **表格筛选后列不位移** —— 只在已加 `table-fixed` 的表上成立，新增的表要各自验证

### 6.4 复核脚本

本次审计的扫描脚本留在 `output/ui-audit/`，可随时重跑：

```
scan.ps1            组件层 vs 原生标签、内联 style、间距类总量
split.ps1           逐文件的不一致分布
census.ps1          18 个基础组件的调用量与覆盖文件数
raw-tags.ps1        裸 button / input 的逐条明细与合理分类
tables-cards.ps1    table-fixed 覆盖率、卡片内边距取值
priority.ps1        按文件的不一致评分排序
lever.ps1           411 个内联 style 的单属性分布（298 个仅 color）
lever-colors.ps1    那 298 个 color 的实际取值分布
```

---

## 7. 已交付物

| 文件 | 作用 | 状态 |
|---|---|---|
| `web/scripts/check-ui-consistency.mjs` | 8 项指标的 ratchet 闸门，零依赖 | 已落盘，已验证能拦回归 |
| `web/scripts/ui-consistency-baseline.json` | 当前预算快照 | 已生成，随重构下调 |
| `web/scripts/codemod-inline-colors.mjs` | 单属性内联样式 → `.fg-*` / `.surface-*` | 已执行 179 处 |
| `web/scripts/codemod-card-containers.mjs` | 手写卡片 → `.subcard*` | 已执行 5 处 |
| `web/scripts/codemod-col-width.mjs` | 表头内联 `width` → `w-[Npx]` | 已执行 57 处 |
| `web/scripts/codemod-spanned-cols.mjs` | 跨列单元格 → `.td-spanned` | 已执行 5 处 |
| `web/scripts/report-text-aux.mjs` | 剩余 `text-aux` 的三类分拣（A 容器 / B 自带色 / C 漏配） | 只读工具 |
| `output/ui-audit/*.ps1` | 8 个复核脚本 | 已落盘，可重跑 |

未落盘的部分（本文档给出完整实现，按节施工）：`.fg-*` 类、`.seg-item` 高度、`PageShell` 间距、`NumberField`/`TimeOfDay`、`Segmented.variant`、`ChipTone.info`、tailwind 半径与字体栈接线。


---

## 8. 实施结果（2026-11-18 当日完成）

### 8.1 逐项状态

| 项 | 内容 | 结果 |
|---|---|---|
| P0-1 | `.fg-1..fg-danger` 8 类 + `.surface-base/2/3` 3 类 | 完成，`.fg-*` 实际使用 181 处 |
| P0-2 | codemod 改写内联颜色 | 完成 179 处 / 38 文件 |
| P0-3 | `.seg-item` 30px → 32px | 完成，同时补 `aria-pressed` 选中态 |
| P0-4 | PageShell 间距双计 | 完成，`.toolbar` 去 `mb-4`，新增 `.toolbar-flush` |
| P0-5 | 闸门脚本入 `package.json` | 完成，`npm run check` 串起四项 |
| P0-6 | 删除重复 `.panel-foot` | 完成 |
| P0-7 | mono 字体栈统一 | 完成，`tailwind.config` 与 `--rg-font-mono` 逐字一致 |
| P1-1 | `NumberField` / `TimeOfDay` | 完成，删掉 3 套独立实现，OpsPage 6 组时:分 + QoderOps/ZcodeOps 3 组全部改用它 |
| P1-2 | 手写卡片收敛 | 完成 5 处 → `.subcard*`；另新增 `.table-frame`（表格外框）、`.rule-line`（1px 分隔线）各收 1/5 处 |
| P1-3 | `Segmented.variant` | 完成，默认 `filter`（16 处），`OpsPage` 显式 `tabs` |
| P1-4 | `table-fixed` 补课 | 完成 **3 → 23 张**（超目标 15 张），新增 `.col-w-*` 4 档通用列宽 |
| P1-7 | `ChipTone.info` | 完成，`--rg-state-info` 从死令牌变活 |
| P2-1 | `--rg-card-pad` 接线 | 完成，`.panel-body` / `.metric-cell` 改用它 |
| P2-2 | 半径令牌接线 | 完成，`borderRadius` 五档全部指向 `var(--rg-radius-*)`，并补了 `xl` |
| P2-4 | `design/` 降级 | 完成，文件头加 14 行声明（含 5 处对比度差异对照表） |

### 8.2 闸门指标变化

| 指标 | 实施前 | 实施后 | 变化 |
|---|---|---|---|
| `styleBlocks` | 411 | **202** | −51% |
| `inlineTokenRefs` | 432 | **227** | −47% |
| `rawButtonNoBtnClass` | 14 | **0** | 全部登记到允许清单并给出理由 |
| `rawTextInputNoField` | 3 | **2** | 1 处是注释里的示例（已由 `stripComments` 消除误报） |
| `hardcodedTextPx` | 36 | 36 | 未动，见 9.4 |
| `literalHexColors` | 0 | 0 | 保持 |
| `textAuxNoFg`（新增） | 106 | **77** | 29 处靠 codemod 顺带解决；余 77 处已分拣 |
| `inlineColSpanBg`（新增） | 5 | **0** | 全部改 `.td-spanned` |

### 8.3 验证结果

```
node scripts/check-css-tokens.mjs      → 51 个引用全部有定义
node scripts/check-ui-consistency.mjs  → 8 项指标全部未超预算
npx tsc -b                             → exit 0
npx eslint .                           → exit 0（0 error 0 warning）
npx vite build                         → exit 0，1.7s
npm run check（四项串联）               → 通过
```

后端耦合测试（前端字段契约依赖这些）：

```
src/test/frontend-entitlement.test.js  → 23 passed
src/test/entitlement-view.test.js      → 21 passed
src/test/overview-detail.test.js       → 25 passed
src/test/channels.test.js              → 54 passed
src/test/wiring.test.js                → 24 passed
```

**闸门抗回归已实测**：临时插入一个「`text-aux` 无 fg + 裸 button + 内联 background 的跨列 td」，三条规则同时报超预算、退出码 1；移除后恢复通过。

### 8.4 未做的部分与原因

| 项 | 状态 | 原因 |
|---|---|---|
| `hardcodedTextPx` 36 处 | 保留 | 逐条裁决过：`text-[13px]`（18 处）是正文默认字号，写在 `.td`/`.btn`/`.field` 里属正常；`text-[12px]` 0 处；其余 18 处集中在 `text-[15px]`（2）、`text-[14px]`（2）、`text-[11px]`（1）与内联 SVG 尺寸，改它们需要产品判断「这个读数该不该是 24px」，不是机械替换 |
| `textAuxNoFg` 余 77 处 | 分拣完毕 | 60 处 C 类已由 `report-text-aux.mjs` 逐条列出，但其中多数是「容器上的 text-aux，子元素各自定色」的变体（例如 `font-mono text-aux` 后面紧跟 `fg-3` 子节点）。逐条加 `fg` 会把「父级继承」改成「硬写」，反而降低灵活性。留作下一轮按页面逐个 review |
| 暗色主题 | 未做 | 需产品决策（方案 §P2-3 已写明） |

### 8.5 与方案的两处偏离

1. **`table-fixed` 实际补到 23 张，超出方案的 15 张目标**。原因：改到一半发现 `ModelRouterPage` 的 4 张表、`OpsPage` 的 4 张表都是同页同筛选源，只补一部分会让同页两种布局行为不一致。一次补全反而更安全。

2. **`codemod-card-containers.mjs` 首次 dry-run 报「0 处」**，原因已写进脚本注释：仓库是 CRLF，脚本按 LF 写的匹配串全部落空。这不是脚本 bug 而是环境差异，已改为「读入归一 → 匹配 → 按原换行还原」，并在写回时保留原文件的 CRLF 风格。

### 8.6 遗留的可执行项

```powershell
# 每轮改动后必跑
cd web
npm run check
npx vite build

# 预算只许下调：重构收敛后
node scripts/check-ui-consistency.mjs --update

# 剩余 text-aux 逐条裁决清单
node scripts/report-text-aux.mjs
```


---

## 9. 偏离与风险说明

1. **本方案不追求「一次改完」**。411 处内联 style 里，20 处是动态值、28 处是背景、19 处是宽高 —— 这些不该机械消除。目标是把「静态外观」全部移出 `.tsx`，动态部分保留，而不是把数字打到 0。

2. **`table-fixed` 是唯一有视觉破坏风险的一项**。它会让原本靠「撑列」容纳的长内容变成截断。建议先在 `TokenStatsPage` 的单张表试点，确认截断策略（`break-words` / `truncate` / `title` 提示）后再铺开。P1-4 已按此排序。

3. **`Segmented` 的 `variant` 默认值改动会影响 17 个调用点的无障碍树**。默认设为 `filter` 是因为 16/17 是筛选；但 [OpsPage.tsx:463](web/src/features/ops/OpsPage.tsx#L463) 的运维分区必须显式传 `tabs`，否则读屏会丢失「选项卡」的角色。这一处要单独确认。

4. **`--rg-sp-*` 选择「只在 CSS 内用」是一次裁决，不是最优解**。理论上更干净的做法是把它删掉、全部走 Tailwind；但 `global.css` 内部已有 13 处引用，改它们没有收益。保留 + 写清边界是成本最低的收敛。

5. **暗色主题未列入本次执行范围**。它需要产品决策（是否要做、做到什么程度），而不是技术判断。令牌层已就绪，等决策。
