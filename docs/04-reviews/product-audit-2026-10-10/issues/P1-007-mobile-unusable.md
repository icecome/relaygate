# P1-007 — 移动端零断点，390px 下主区仅约 174px

| 字段 | 值 |
|---|---|
| **Priority** | P1 |
| **Category** | UX / 响应式 |
| **Labels** | `ux`, `p1`, `frontend`, `mobile`, `responsive` |
| **Difficulty** | 中（约 3 小时） |
| **Risk** | 中（触到布局核心，需逐页视觉验证） |
| **来源** | product-professor full audit 2026-10-10 |

---

## Evidence

### 布局核心

[AppLayout.tsx:34-35](../../../../web/src/app/AppLayout.tsx#L34-L35)：

```tsx
<div className="flex h-screen overflow-hidden bg-white">
  <aside className="w-[216px] shrink-0 flex flex-col" ...>
```

- 固定 `w-[216px]` + `shrink-0` —— 侧栏在任何视口宽度下都占 216px
- **全库无任何 `@media` 布局断点**：`global.css` 无媒体查询调整布局；`tailwind.config.ts` 无自定义 `screens`；全部页面组件无 `md:` / `lg:` 前缀的布局类
- `flex h-screen overflow-hidden` —— 无滚动收纳机制

### 视口数学

| 视口 | 侧栏 | 主内容区 |
|---|---:|---:|
| 1920px | 216px | 1704px ✅ |
| 1280px | 216px | 1064px ✅ |
| 768px（平板竖屏） | 216px | 552px ⚠️ |
| **390px（iPhone）** | **216px** | **174px** ❌ |

### 最不可用的页面

[CredentialsPage.tsx:319-467](../../../../web/src/features/accounts/CredentialsPage.tsx#L319-L467) —— `table-fixed w-full` 的 **10 列表格**：

启用 / 账号 / 状态 / 平台 / 权益包 / 权益到期 / 账号到期 / 余额额度 / 冷却至 / 操作

174px 内排 10 列 = 每列 17px。**内容全部竖排挤压，不可读。**

[TokenStatsPage.tsx](../../../../web/src/features/stats/TokenStatsPage.tsx) 的 7 个表格、[OpsPage.tsx](../../../../web/src/features/ops/OpsPage.tsx) 的 4 个表格（含 8 列账号池快照）情况相同。

### 相关问题

- 行内操作按钮 [CredentialsPage.tsx:444-462](../../../../web/src/features/accounts/CredentialsPage.tsx#L444-L462)：三个 `size="sm"` 按钮以 `gap-1.5` 紧贴 —— `Button size="sm"` 是 `h-6`（24px），**低于 44px 触控目标标准**
- 「删除」按钮 `variant="danger"` 与另两个**视觉重量接近**，小屏上极易误触
- 顶部时钟 [AppLayout.tsx:10-23](../../../../web/src/app/AppLayout.tsx#L10-L23) 每秒 setState，在低端手机上叠加滚动卡顿

### 项目自己的判断

[docs/04-reviews/ui-review-2026-10-04.md](../../../../docs/04-reviews/ui-review-2026-10-04.md) 早已将其列为 **CRITICAL**：

> **[CRITICAL] Layout.tsx:8 + Sidebar.tsx:27 — 移动端零适配**。… 390px 视口下主区仅剩 ~190px，内容竖排挤压（实测截图已在对比报告留档）。这是整个 v5 前端升级的第一优先。

预发布检查单里「移动端 390px 完整可用」被勾选为 `[x]` —— **但代码里没有任何断点，该项检查与实际不符。**

---

## Why it matters

场景：运维者人在外面（出差/通勤），家里网关的某个账号挂了，想用手机排查。

**当前答案：不可能。** 打开面板就是一条 216px 的侧栏 + 一团竖排挤压的字符。

这不是"优化项"，是**核心场景（远程排障）的完全缺失**。对一个"自托管网关"，主人不在电脑前的时刻恰恰是最需要面板的时刻。

---

## Expected behavior

| 视口 | 行为 |
|---|---|
| ≥ 1024px | 现状不变（侧栏 + 主区） |
| 768-1023px | 侧栏收窄为图标栏（或保持，主区 ≥ 550px 可用） |
| < 768px | 侧栏收为抽屉（汉堡按钮），主区全宽；表格卡片化 |

所有触控目标 ≥ 44px；破坏性操作与普通操作在小屏上视觉分离。

---

## Acceptance criteria

1. Chrome devtools 390×844 下可走通全部 8 条路由，无横向滚动条。
2. `< 768px` 时侧栏默认隐藏，汉堡按钮可唤起；主区占满宽度。
3. 凭据表、任务日志表、请求明细表在移动端渲染为卡片列表（每行一卡，字段 label: value 竖排）。
4. 所有按钮触控目标 ≥ 44×44px（移动端断点下）。
5. 「删除」按钮在移动端与其他操作视觉分离（单独一行或红色边框加强）。
6. 桌面端（≥1024px）视觉零回归。

---

## Implementation notes

### 方案：两个断点 + 表格卡片化

1. **`AppLayout.tsx`**：
   - `< 768px`：`<aside>` 改 `fixed inset-y-0 left-0 z-50 -translate-x-full transition-transform`，加一个 `useState` 控制的汉堡按钮（fixed top-left，44×44px），打开时加 `translate-x-0` + 遮罩层
   - 主区 `padding` 降为 `p-3`
2. **表格卡片化**（复用项目已有设计稿——[design/relaygate-console/pages/credentials.html](../../../../design/relaygate-console/pages/credentials.html) 里已有一份移动端原型，字段 label 用 `data-label` + `td::before` 的纯 CSS 方案，无需改 JSX 结构）：

   ```css
   @media (max-width: 767px) {
     .card-table thead { display: none; }
     .card-table tr { display: block; border: 1px solid var(--rg-border); border-radius: 8px; padding: 8px; margin-bottom: 8px; }
     .card-table td { display: flex; justify-content: space-between; }
     .card-table td::before { content: attr(data-label); color: var(--rg-text-tertiary); }
   }
   ```

   然后给每个 `<td>` 加 `data-label="账号"` 等。**这是改动最小的方案**（不动 JSX 逻辑，只加属性 + CSS）。
3. **触控目标**：移动端断点下给 `.btn-sm` 加 `min-height: 44px; min-width: 44px;`。
4. **时钟**：`Clock` 组件移动端降为 1 分钟粒度（`window.innerWidth < 768 ? 60000 : 1000`），或干脆移除秒针。

### 不要做

- 不要引入 UI 框架或 CSS-in-JS
- 不要做暗色模式（另一条审查线的事，见 [docs/04-reviews/ui-review-2026-10-04.md](../../../../docs/04-reviews/ui-review-2026-10-04.md)）
- 不要做平板专属布局（768-1023 保持桌面布局即可，可用性可接受）

---

## 可直接执行的修复提示词

```
为 RelayGate 管理面板补移动端适配。当前全库无任何布局断点：
AppLayout.tsx:34-35 是 `flex h-screen` + 固定 `w-[216px] shrink-0` 侧栏，
390px 视口下主内容区只剩约 174px，而 CredentialsPage 是 10 列 table-fixed 表格 —— 完全不可用。
docs/04-reviews/ui-review-2026-10-04.md 早已把这项列为 CRITICAL 且预发布检查单勾选了已完成，但代码里没有断点。

请按"两个断点 + 纯 CSS 表格卡片化"的最小方案执行：

1) web/src/app/AppLayout.tsx：
   - < 768px：aside 改为 fixed 抽屉（-translate-x-full，z-50），
     加一个 44×44 的汉堡按钮（fixed top-left）与遮罩层，点击切换。
     用 useState 控制，不引入新依赖。
   - 主区 padding 从 p-6 降为 p-3（仅移动端断点）。
   - ≥ 1024px 保持现状零变化。

2) 表格卡片化（纯 CSS 方案，不改 JSX 逻辑）：
   在 web/src/styles/global.css 的 @layer components 里加
   @media (max-width: 767px) 规则块：
   .card-table thead { display:none }
   .card-table tr { display:block; border:1px solid var(--rg-border); border-radius:8px; padding:8px; margin-bottom:8px }
   .card-table td { display:flex; justify-content:space-between; gap:8px }
   .card-table td::before { content:attr(data-label); color:var(--rg-text-tertiary); flex-shrink:0 }
   .card-table td.cell-act::before { content:none }  /* 操作列不显示 label */
   然后给以下表格的每个 <td> 加 data-label：
   - CredentialsPage.tsx 主表（10 列）与「最近操作与保活」表（6 列），table 加 className="card-table"
   - OpsPage.tsx 账号池快照表（8 列）、轮换账号表（6 列）、任务日志表（6 列）
   - TrafficPage.tsx 请求明细表（9 列）
   - TokenStatsPage.tsx 的每日对照表（4 列）、模型用量表、账号用量表
   - AccessKeysPage.tsx 密钥表
   - ModelPoolPage.tsx 模型清单、ModelRouterPage.tsx 的 provider 表与虚拟模型表

3) 触控目标：移动端断点下
   .btn-sm { min-height: 44px; min-width: 44px; }
   并给 .btn-danger 增加更强的视觉分离
   （例如移动端下 border: 1px solid var(--rg-state-error)）。

4) AppLayout.tsx 的 Clock 组件：移动端（window.innerWidth < 768）降为 60000ms 间隔。

5) 验证：Chrome devtools 390×844 逐页走通全部 8 条路由，确认无横向滚动、
   表格可读、按钮可点；再验证 1920×1080 桌面端零回归。

不要引入任何新依赖；不要做暗色模式；不要做平板专属布局。
```