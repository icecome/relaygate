# P1-002 — 首登引导断裂，核心流程需 4 次跳转且无引导

| 字段 | 值 |
|---|---|
| **Priority** | P1 |
| **Category** | UX / 核心流程 |
| **Labels** | `ux`, `p1`, `frontend`, `onboarding` |
| **Difficulty** | 中（约 3 小时） |
| **Risk** | 低（纯新增，不改现有路径） |
| **来源** | product-professor full audit 2026-10-10 |

---

## Evidence

### 断裂 1：创建密钥 = 引导结束

[SetupGate.tsx:224-250](../../../../web/src/features/setup/SetupGate.tsx#L224-L250) —— 创建成功后只有两个按钮：「复制密钥」「进入面板」。**没有任何"下一步做什么"。**

点击「进入面板」→ 落到 `/` 总览 → [OverviewPage.tsx:176-181](../../../../web/src/features/overview/OverviewPage.tsx#L176-L181) 渲染纯灰字 **「暂无账号数据」**，零引导、零按钮、零链接。

用户此时必须自己猜出：**左侧「账号」→「凭据池」→ 上方「接入新账号」Panel → 三个按钮之一**。全程 3 次跳转，无一处提示。

### 断裂 2：WorkBuddy 导入后账号默认停用，弹窗已关

[ImportWbDialog.tsx:59](../../../../web/src/features/accounts/ImportWbDialog.tsx#L59) toast「已导入 WorkBuddy 账号（默认停用）」
[ImportWbDialog.tsx:63](../../../../web/src/features/accounts/ImportWbDialog.tsx#L63) —— **toast 之后立即关弹窗**
[ImportWbDialog.tsx:187](../../../../web/src/features/accounts/ImportWbDialog.tsx#L187) Note「导入的账号默认处于停用状态，需在凭据池确认后手动启用。」

**该 Note 在弹窗关闭后用户就看不到了。** 用户必须自己在 525 行的表里找到那个新行，点一个只写着「开」/「关」两个字的按钮（[CredentialsPage.tsx:346-354](../../../../web/src/features/accounts/CredentialsPage.tsx#L346-L354)）。无 toast 指向、无行高亮、无跳转。

### 断裂 3：最常见的故障没有修复入口

[accountPacks.tsx:234-236](../../../../web/src/features/accounts/accountPacks.tsx#L234-L236) —— `refreshToken` 过期时 label = `'需重新登录'`，tone = `danger`（红色）。

该状态渲染在 [CredentialsPage.tsx:390-426](../../../../web/src/features/accounts/CredentialsPage.tsx#L390-L426) 的「账号到期」列，但**行内操作只有签到 / 查余额 / 删除**（[:444-462](../../../../web/src/features/accounts/CredentialsPage.tsx#L444-L462)）。

真正的修复入口（粘贴凭据导入 / Trae OAuth）在 [CredentialsPage.tsx:288-301](../../../../web/src/features/accounts/CredentialsPage.tsx#L288-L301) 的**独立 Panel**，位于表格**上方**。

→ **用户看到红色告警的那一行，没有任何操作能解决它。**

### 断裂 4：客户端接入链路无交叉链接

| 步骤 | 位置 | 该页是否提及下一步 |
|---|---|---|
| mint 访问密钥 | `/access-keys` | ❌ 全页 0 行提及 base URL |
| 知道放哪 | `/ops/config` 第 **5** 个分段 | ⚠️ 仅在 footer 提到"访问密钥" |
| 验证能用 | `/traffic` 连通性测试 | ❌ 全页 0 行提及客户端接入 |

**3 页 0 交叉链接**，且第 2 步藏在一个用户可能不知道存在的分组里。

---

## Why it matters

首次使用是**唯一一次**用户会认真读指引的时刻。此刻的断裂造成的流失是不可逆的：用户不知道该做什么 → 关掉页面 → 之后只在出故障时回来 → 而出故障时他同样找不到修复入口（断裂 3）。

**这是「功能都在但用户不会用」的典型形态。** 它也解释了为什么核心功能分 82 而 UX 分 38。

---

## Expected behavior

1. 创建首把密钥后，系统知道用户"还差哪几步"，并在总览页顶部持续提示直到完成。
2. WorkBuddy 导入成功后，在弹窗关闭前给一个明确的"立即启用"动作。
3. 凭据行显示「需重新登录」时，该行有一个能直接修复它的按钮。
4. mint 密钥 → 配置 → 验证，三步互相可跳转。

---

## Acceptance criteria

1. 新账号导入后，总览页顶部出现「还差 N 步」进度条（见 Implementation notes 的步骤定义）。
2. 完成全部步骤后进度条自动消失，刷新后不再出现。
3. WorkBuddy 导入成功态：弹窗不自动关闭，显示「账号已导入（默认停用）」+「立即启用」按钮，点击后账号 `enabled=true` 并刷新列表。
4. 凭据行 `keepaliveOf(a).label === '需重新登录'` 时，该行操作区出现「重新登录」按钮（打开 OauthTraeDialog 预填该账号）。
5. `/access-keys` 页面在密钥创建成功后展示 base URL + curl 示例 + 「验证连通性」跳转。
6. `TrafficPage` 的连通性测试区有指回「客户端接入」的链接。

---

## Implementation notes

### 步骤定义（建议 3 步）
```ts
steps = [
  { id: 'account', label: '接入第一个账号',
    done: summary.accounts.length > 0, path: '/credentials' },
  { id: 'key',      label: '创建访问密钥',
    done: accessKeys.length > 0,    path: '/access-keys' },
  { id: 'verify',   label: '验证链路可用',
    done: localStorage['rg_verified'] === '1', path: '/traffic' },
]
```

### 渲染位置
`AppLayout.tsx` 的 `<main>` 内、`PageShell` 之上。**仅当存在未完成步骤时渲染**；完成后不再出现。**不要用弹窗**——弹窗会打断正在浏览页面的用户。

### `verify` 步骤的完成判定
最小侵入方案：`TrafficPage` 的连通性测试成功后 `localStorage.setItem('rg_verified','1')`。
若用户已在别处验证过（如 curl），可用一个宽松探测：向 `/v1/models` 发一次带密钥的请求并把 `localStorage` 的种子值匹配该密钥（避免换密钥后一直显示"未完成"）。

---

## 可直接执行的修复提示词

```
修复 RelayGate 管理面板的首登引导断裂。当前：
SetupGate 创建密钥后落进 OverviewPage:180 的「暂无账号数据」（零下一步）；
WorkBuddy 导入后账号默认停用但弹窗已关（用户不知道要去点「开」）；
凭据行显示红色「需重新登录」时行内没有任何能修复它的操作；
mint 密钥 → 配置 IDE → 验证三步之间 0 交叉链接。

请执行：

1) 新建 web/src/features/setup/onboarding.ts
   导出 useOnboarding() hook：
   - 输入：SummaryProvider 的 summary、listAccessKeys('access') 的结果、当前 pathname
   - 输出：{ steps: [{id,label,done,path}], remaining: number, next: step|null }
   - 步骤固定为三条：
     account 接入第一个账号（done: summary.accounts.length > 0，path '/credentials'）
     key      创建访问密钥（done: accessKeys.length > 0，path '/access-keys'）
     verify   验证链路可用（done: localStorage['rg_verified']==='1'，path '/traffic'）

2) web/src/app/AppLayout.tsx
   在 <main> 内、Outlet 之上渲染进度条，仅当 remaining > 0 时显示。
   文案形如「还差 2 步：创建访问密钥」，配一个跳转按钮。
   样式复用现有的 Chip / Panel 组件，不要引入新依赖。
   全部完成后自动不渲染。

3) web/src/features/accounts/ImportWbDialog.tsx
   导入成功后不要直接 onClose()，改为设置一个 success 状态渲染：
   「账号已导入（默认停用）」+ 两个按钮：
     「立即启用」→ patchAccount(newId, {enabled:true}) 然后 onImported() 并关闭
     「稍后处理」→ 直接 onImported() 并关闭
   注意：wbImport 的响应里需要有账号 id，若当前返回体不含，请改为导入后再调一次
   listAccounts 找到 enabled=false 的 WorkBuddy 账号（按 label 或 uid 匹配）。

4) web/src/features/accounts/CredentialsPage.tsx
   行的操作区，当 keepaliveOf(a).label === '需重新登录' 时，
   在签到/查余额/删除之前插入一个「重新登录」按钮（variant="primary"），
   点击打开 OauthTraeDialog（新增一个可选的 presetLabel prop 用于标题提示）。

5) web/src/features/accounts/AccessKeysPage.tsx
   在「最近生成的明文」Panel 下方新增「下一步：配置客户端」区块：
   调 getClientConfig() 展示 baseUrl + openai.curl + 复制按钮，
   并给一个「验证连通性」按钮 → navigate('/traffic')。
   同时在页脚加一句「这些密钥在「访问密钥」页创建 →」跳回本页的链接不需要，
   但需要在该区块里说明「访问密钥用于转发面，登录密钥用于面板，两者不可混用」。

6) web/src/features/stats/TrafficPage.tsx
   连通性测试成功后 localStorage.setItem('rg_verified','1')；
   在该区块标题旁加一句「用于验证从「客户端接入」页复制的配置是否可用」+ 反向链接。

7) 修 P1-003 的配套：CredentialsPage.tsx:316 的空状态区分两种情况——
   list.data.length === 0（首次使用）→ 显示 CTA「接入新账号」按钮
   list.data.length > 0（筛选无结果）→ 显示「清除筛选」按钮

完成后运行 npx tsc -b --force && npm run lint 确认零错误。
```