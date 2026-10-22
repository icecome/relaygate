# P1-006 — 三处 CSS 引用不存在的东西 + tailwind 化石配置

| 字段 | 值 |
|---|---|
| **Priority** | P1 |
| **Category** | 设计系统 / 工程完成度 |
| **Labels** | `bug`, `css`, `p1`, `frontend`, `design-system` |
| **Difficulty** | 极低（10 分钟） |
| **Risk** | 极低（改的是未定义引用与死配置） |
| **来源** | product-professor full audit 2026-10-10（**evidence-verifier 独立复核确认**） |

---

## Evidence（全部经过独立复核，非转述审查员）

### 复核方法

```powershell
# 1) 提取 global.css 定义的全部 CSS 变量
DEFINED = 48 个 (--rg-*)
# 2) 全 web/src 提取所有 var(--rg-*) 引用
USED = 23 个
# 3) 差集：USED 但 NOT DEFINED
→ --rg-bg-primary
→ --rg-state-ok
```

### 发现 1：`--rg-bg-primary` 未定义

[web/src/shared/ui/index.tsx:126](../../../../web/src/shared/ui/index.tsx#L126)（Stepper 组件）：

```tsx
style={{ borderColor: 'var(--rg-border-stronger)', background: 'var(--rg-bg-primary)' }}
```

token 层只定义了 `--rg-bg-base` / `--rg-bg-secondary` / `--rg-bg-tertiary`（[global.css:49-51](../../../../web/src/styles/global.css#L49-L51)）。**`--rg-bg-primary` 不存在 → Stepper 的 background 实际不生效**（回退为透明）。

### 发现 2：`--rg-state-ok` 未定义

同文件区域使用 `var(--rg-state-ok)`。token 层定义的是 `--rg-state-success`（[global.css:61](../../../../web/src/styles/global.css#L61)）。此处有 fallback 值，**不致命但同样是无效引用**。

### 发现 3：`.t-label` 类从未定义

[web/src/features/ops/ClientAccessPanel.tsx:59](../../../../web/src/features/ops/ClientAccessPanel.tsx#L59) 与 [:142](../../../../web/src/features/ops/ClientAccessPanel.tsx#L142)：

```tsx
<span className="t-label">{title}</span>
```

已核实：`global.css` 全 560 行中 `t-label` **0 命中**。这两处标签（curl 示例的区块标题、「接入注意」的标题）**当前没有任何样式**——它们渲染为默认字号的裸文本。

### 发现 4：tailwind.config.ts 是"生成后弃用"的化石

[web/tailwind.config.ts:3](../../../../web/tailwind.config.ts#L3) 注释：

> 色值权威来源为 styles/tokens.css（映射 TraeWork 设计系统）

**`web/src/styles/tokens.css` 不存在**（token 实际在 [global.css](../../../../web/src/styles/global.css)）。

且该 config 定义了一整套 palette（brand/ink/ok/warn/danger/line/surf 全套语义色），但全库 grep 确认 **0 处使用**这些 tailwind 语义色类（无任何 `bg-brand-*`、`text-ink-*`、`border-line`、`text-danger`）。作者实际全部走 CSS 变量 + `style={{}}` 内联（254 处 `text-[Npx]` 任意值 + 241 处内联样式）。

---

## Why it matters

**这三处 + 一份化石配置是整个审计中最硬的"AI 生成感"证据**，因为它们证明的不是"写得不好"，而是**"生成之后没有人打开页面看过一眼"**：

- `--rg-bg-primary` 这种错误，人手写时会立刻发现（背景是白的，和设计不符）
- `.t-label` 这种错误，人手写时会在样式表里先加类
- 指向不存在文件的注释，人手写时不会产生（人知道文件在哪）

修复成本 10 分钟，回报是消除了最强的一条"没人看过"的信号。

---

## Expected behavior

1. 所有 `var(--rg-*)` 引用的变量都在 `global.css` 中定义（或引用处有显式 fallback）。
2. 所有 `className` 引用的类在 `global.css` 中定义（或删除该类引用）。
3. `tailwind.config.ts` 不包含指向不存在文件的注释与从未使用的 palette。

---

## Acceptance criteria

1. 运行一个简单的脚本/检查：`USED(var(--rg-*)) ⊆ DEFINED(:root)`。当前差集为空。
2. `t-label` 两处要么被定义、要么被替换为已存在的等价类。
3. `tailwind.config.ts` 中不再引用 `styles/tokens.css`，palette 块被删除或真正被使用。
4. `npx tsc -b --force`、`npm run lint`、`npm run build` 全部通过。
5. Stepper 组件的背景色生效（视觉验证：ModelRouterPage 的轮转池 Stepper）。

---

## Implementation notes

### `t-label` 的处理（二选一）

**方案 A（推荐）**：在 `global.css` 的 `@layer components` 中补定义，参照同文件已有的 `.t-value` 或类似类：

```css
.t-label {
  font-size: 12px;
  color: var(--rg-text-secondary);
  letter-spacing: 0.02em;
}
```

**方案 B**：ClientAccessPanel 两处改为已有的 `text-[12px]` + `style={{ color: 'var(--rg-text-secondary)' }}` 内联（与文件其他地方一致）。

### tailwind.config.ts 的处理（二选一）

**方案 A（推荐，保守）**：删除 palette 块与 `styles/tokens.css` 注释，保留 `content` 路径与 `preflight` 等真正在用的配置。Tailwind 继续作为间距/flex 工具。

**方案 B（激进，不建议现在做）**：真正迁移——把 `global.css` 的 token 改写为 tailwind theme 扩展，全部内联样式改为语义类。工作量大，收益存疑（现状的内联写法虽啰嗦但一致）。

### 防回归

在 `web/package.json` 加一个校验脚本（可选）：

```json
"check:tokens": "node scripts/check-css-tokens.mjs"
```

脚本逻辑：正则提取 `global.css` 的 `--rg-*:` 定义与 `web/src` 的 `var(--rg-*)` 引用，断言引用 ⊆ 定义。20 行代码，防复发。

---

## 可直接执行的修复提示词

```
修复 RelayGate 前端 CSS 层的四处"引用了不存在的东西"。

已核实的事实（不要重新调查，直接修）：
1) web/src/shared/ui/index.tsx:126 使用 var(--rg-bg-primary)，
   但 token 层（web/src/styles/global.css:23-86）只定义了
   --rg-bg-base / --rg-bg-secondary / --rg-bg-tertiary，没有 --rg-bg-primary。
   → Stepper 组件的 background 实际不生效。
2) 同文件使用 var(--rg-state-ok)，但只定义了 --rg-state-success。
3) web/src/features/ops/ClientAccessPanel.tsx:59 和 :142 使用 className="t-label"，
   但 global.css 全文 0 处定义 .t-label，这两处标签当前无任何样式。
4) web/tailwind.config.ts 第 3 行注释指向 styles/tokens.css —— 该文件不存在；
   且该 config 定义的整套 brand/ink/ok/warn/danger/line/surf palette
   在 web/src 中 0 处使用（全部走 CSS 变量 + 内联样式）。

请执行：

1) index.tsx:126 的 var(--rg-bg-primary) 改为 var(--rg-bg-base)。
2) index.tsx 中的 var(--rg-state-ok) 改为 var(--rg-state-success)。
3) t-label 二选一：
   a) 在 global.css 的 @layer components 里补 .t-label 定义
      （12px、color: var(--rg-text-secondary)、letter-spacing: 0.02em，
      参照同文件相邻类的写法）
   b) 或 ClientAccessPanel 两处改用文件内已有的等价内联写法
      （className="text-[12px]" + style color var(--rg-text-secondary)）。
   选与文件现状更一致的那种。
4) tailwind.config.ts：删除指向不存在文件的注释与整个未使用的 palette 块，
   保留 content 路径、preflight 与其他真正在用的配置。
   不要尝试把 CSS 变量迁移到 tailwind theme —— 那是大工程且当前内联写法是一致的。
5) 可选但推荐：新增 scripts/check-css-tokens.mjs（约 20 行），
   正则提取 global.css 的 --rg-*: 定义与 web/src 的 var(--rg-*) 引用，
   断言引用集合 ⊆ 定义集合；在 web/package.json 加 "check:tokens" script。
6) 运行 npx tsc -b --force && npm run lint && npm run build 确认全部通过。
7) 视觉验证：打开 /model-router 页面，确认「轮转池大小」Stepper 的背景色不再是透明的。
```