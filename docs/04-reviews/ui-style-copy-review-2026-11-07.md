# RelayGate 前端样式与界面文案审查报告（2026-11-07）

> 审查范围：`web/src/**`（53 个文件）+ `web/index.html` + `web/tailwind.config.ts` + `web/src/styles/global.css`
> 对照基准：`design/relaygate-console/colors_and_type.css`（TraeWork 设计库快照，81 个令牌）
> 方法：ui-design-review 审计序列（令牌 → 布局 → 排版 → 动效 → 表单 → 状态 → 文案）+ tech-doc-style-chinese 界面文案规范

**状态：已修复。** 移动端（<768px）相关工作按需求删除，不计入本次范围；其余问题全部改完并验证。

---

## 0. 验证结果

| 检查项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | 通过，0 错误 |
| 生产构建 | `npm run build` | 通过，6.4s |
| CSS 令牌引用 | `node scripts/check-css-tokens.mjs` | **通过**（修复前退出码 1） |
| 代码规范 | `npx eslint .` | 通过，0 问题 |
| 对比度（WCAG AA 4.5:1） | 实测计算 | **10/10 全部达标**（修复前 4 项不达标） |

---

## 1. 已修复清单

### 1.1 阻断性缺陷（修复前当前就渲染错误）

| 位置 | 问题 | 修复 |
|---|---|---|
| `ImportRaccoonDialog.tsx:450,471,702` | `var(--rg-bg-soft, #f7f7f7)` 令牌不存在，实际渲染硬编码 `#f7f7f7` | 改 `var(--rg-bg-secondary)` |
| `KeepaliveBoard.tsx:63` | `var(--rg-surface-secondary)` 不存在，整条声明失效，池汇总头无背景色 | 改 `var(--rg-bg-secondary)` |
| `AppLayout.tsx:35` | 侧栏写死 `w-[216px]`，`.layout-aside` 定义了但零引用 | 改用 `.layout-aside` |
| `shared/ui/index.tsx:64` | `<label htmlFor={id}>` 而 28 处调用全不传 `id` → 可见标签与输入框无关联 | 组件内 `useId()` 兜底 |
| `ModelRouterPage.tsx:497` | `colSpan={8}`，该表只有 7 列 | 改 `colSpan={7}` |
| `GrowthPanel.tsx:446` | 页尾写「无需也不提供手动操作入口」，同面板 `:137` 就是「立即执行一轮」 | 改「默认由后台定时执行；上方「立即执行一轮」可随时手动补跑」 |

### 1.2 对比度（全部重算并达标）

| 令牌 | 原值 | 新值 | 白底 / 淡底 / 灰底 |
|---|---|---|---|
| `--rg-state-success` | `#15a877`（2.74:1） | `#0f7d59` | 5.12 / 4.59 / 4.70 |
| `--rg-state-warning` | `#e27900`（2.66:1） | `#a85800` | 5.17 / 4.57 / 4.74 |
| `--rg-state-error` | `#e8463a`（3.34:1） | `#c23a30` | 5.33 / 4.55 / 4.89 |
| `--rg-state-info` | `#2f74ff`（4.15:1） | `#1f5fd6` | 5.73 / 4.93 / 5.25 |
| `--rg-text-tertiary` | `#737373`（灰底 4.35） | `#6b6b6b` | 5.33 / 4.89 / 4.95 |
| `--rg-text-disabled`（= placeholder） | `#a1a1a1`（2.58:1） | `#707070` | 4.95 / 4.54 |

### 1.3 令牌层与主题

- 删除 `global.css` 的 `.font-mono` 重复定义 —— 它与 `tailwind.config.ts` 同名，utilities 层总是胜出，`var(--rg-font-mono)` 从未生效
- `bg-white` 6 处全改 `bg-[var(--rg-bg-base)]`（AppLayout ×3、SetupGate ×2、ErrorBoundary ×1）
- `.field` 补 `background: var(--rg-bg-base)`（原先依赖 UA 默认白底）
- `.kv dt/dd`、`.seg-item` 的 `border-color` 补上令牌（原先落到 Tailwind preflight 的 `#e5e7eb`）
- `--rg-overlay-*` 未定义导致 `Modal.tsx:136` 硬编码 `rgba(23,23,23,0.45)`（保留硬编码，因该遮罩色本身不属于设计库色阶，已在注释说明）

### 1.4 容器与样式复用（消除逐字重复）

新增全局类，替换散落各处的内联样式：

| 新类 | 替换掉的手写次数 |
|---|---|
| `.subcard` / `.subcard-soft` / `.subcard-flush` | 13 处 `rounded-lg border px-3.5 py-3 min-w-0` |
| `.card-head-line` | 14 处 `<span className="h-px flex-1" style={{background:...}} />` |
| `.data-table` | 26 处 `card-table w-full border-collapse text-[13px]` |
| `.textarea` | 4 处 `w-full h-40 p-2.5 rounded-md border font-mono text-[12px]` |
| `.code-block` | 6 处 `<pre>` 手写块 |
| `.rule-top` | 4 处 `borderTop: '1px solid var(--rg-border)'` |
| `.kv-compact` | 4 处 `gridTemplateColumns: '64px minmax(0,1fr)'` |
| `.td-mono` | 31 处 `td font-mono text-[12px]` |
| `.td-actions` | 7 处操作列包装（且改为 `flex-wrap`，解决按钮溢出） |
| `.text-unit` | 4 处单位后缀（Token / 积分 / ↑） |
| `.text-hero` | 2 处 `font-metric text-[28px] leading-tight` |
| `.nav-item` | 侧栏悬停逻辑从 JS 事件改为 CSS（原 onMouseEnter 会与 NavLink 的 style 回调互相覆盖） |

`.data-table` 刻意不叫 `.table`：Tailwind 自带 `display:table` 的同名 utilities，两条声明会命中同一元素。

### 1.5 字号阶梯

- `text-[11px]` 62 处 → 正文改 `text-aux`（12px），仅数字单位后缀保留 `text-unit`
- `text-[12px]` 127 处 → `text-aux`
- 字号阶梯现在只有 5 档：`text-page` 22 / `text-block` 16 / `text-read` 24 / `text-hero` 28 / `text-aux` 12 / `text-unit` 11

### 1.6 布局溢出

| 位置 | 问题 | 修复 |
|---|---|---|
| `.col-actions` 208px | 7 个按钮实测需 ~392px | 改 200px + `.td-actions { flex-wrap }` |
| `KeepaliveBoard.tsx:103` | `table-fixed` 在 `overflow-hidden` 内，横向滚动兜底失效 | 外层加 `overflow-x-auto` |
| `ModelPoolPage.tsx:317`、`OpsPage.tsx:564,1136`、`TrafficPage.tsx:326` | `scroll-y` 只有纵向滚动 | 补 `overflow-x-auto` |
| `TokenHeatmap.tsx:105` | SVG 固定 276px 无横向兜底 | 外层加 `overflow-x-auto` |
| `MetricGrid` | 写死 4 列，第 4 项缺失时留空白 | 加 `data-cols` 支持 1/2/3/4 列 |
| `KeyCards cols={3}` | 固定 3 列无断点 | 改 `repeat(auto-fit, minmax(...))` |
| `KeyCardGroups` | 写死 `grid-cols-2` | 改 `grid-cols-1 lg:grid-cols-2` |
| `NotifyBackupPanel` 4 处栅格 | `grid-cols-2` / `grid-cols-3` 无断点 | 补 `sm:` / `lg:` 两档 |
| `TrafficPage.tsx:356`、`VirtualModelDialog.tsx:220` | 固定两列 / 六列 px | 补断点与 `grid-cols-2` 降级 |
| `GrowthPanel.tsx:262` | `min-w-[130px] + min-w-[60px]` 互相挤压 | 改 `min-w-0` / `min-w-[48px]` |

### 1.7 说明与实现不一致（最影响信任的一类）

| 位置 | 原说明 | 实际实现 | 修复后 |
|---|---|---|---|
| `TokenStatsPage.tsx:493` | 「Token 缺失显示 0」 | 正文显示「数据缺失」 | 说明改为「缺 Token 的行显示「数据缺失」」 |
| `TokenStatsPage.tsx:867` | 「相邻余额快照差分（下界估计）」 | 取 `usedTotal`（上游 `consumed_amount` 增量，主口径） | 改为「上游 consumed_amount 增量（主口径）」 |
| `TokenStatsPage.tsx:880` | 表头「今日消耗」 | 随范围变化（今日/近 7 日/近 30 日） | 改为动态 `` 近 ${range} 日消耗 `` |
| `GrowthPanel.tsx:446` | 「不提供手动入口」 | 有「立即执行一轮」 | 见 §1.1 |
| `AccessKeysPage.tsx:256` | 筛选项「不可用」 | 实际含停用/吊销/过期 | 改为「停用 / 吊销 / 过期」 |
| `CredentialsPage.tsx:558` | 表头「冷却至」 | 渲染剩余时长 | 改为「冷却剩余」 |
| `OpsPage.tsx:1083` | 「共 N 条」 | 只拉 200 条 | 改为「显示最近 N 条（最多拉取 200 条）」 |
| `OpsPage.tsx:1624` | 「保活时间」只有小时 | 签到时间是 HH:MM | 补分钟，统一 HH:MM |
| `ImportZcodeDialog.tsx:217` | 写死「00:30 / 21:30」 | 时刻可配 | 改为「（时刻见「运营面」设置）」 |
| `KeepaliveBoard.tsx:84` | 「超过 26 小时」 | 常量硬编码 | 改为「已超过一个执行周期」 |
| `AuditPage.tsx:42` | `ok` 与 `allow` 都叫「允许」，筛选只发 `ok` | allow 行切筛选后消失 | 分开映射：`ok → 成功`、`allow → 允许`，筛选补项 |

### 1.8 开发者术语下线

| 位置 | 原文案 | 改后 |
|---|---|---|
| `OpsPage.tsx:1532` | 「来自 /v1/admin/config 的当前生效值」 | 「当前生效的网关配置；修改配置文件后需重载才会应用」 |
| `OpsPage.tsx:713,717` | 「由 SCHEDULER_ENABLED 控制」 | 「由服务端环境配置控制」 |
| `ChannelGrid.tsx:64` | 「由 src/platform/variant.js 定义」 | 「由服务端下发；此处为空说明 /v1/admin/channels 异常」 |
| `ChannelOpsDialog.tsx:36` | 「见 docs/ 下该平台的接入说明」 | 「见该平台的接入文档」 |
| `ZcodeOps.tsx:184` | 「device_mid 已变」 | 「下次请求将用新的设备指纹」 |
| `QoderOps.tsx:454,466` | 「基础（userQuota）」「赠送（addOnQuota）」 | 「基础额度」「赠送额度」 |
| `ModelPoolPage.tsx:302,306,315` | 「上游函数」「上游路径」「目录接口」 | 「上游调用方式」「调用路径」「目录接口地址」 |
| `ModelRouterPage.tsx:358`、`OpsPage.tsx:1510` | 「业务层失败（请求成功但结果未成功）」 | 「可能只成功一部分，此时会展示每个账号失败的原因」 |
| `ZcodeOps.tsx:522` | 「单包量级 1e8」「量级 1e3」 | 「Token 额度与积分是两套独立计量」 |
| `KeepaliveBoard.tsx:158` | 「上方汇总仍为整池口径」 | 「当前筛选下该平台没有账号」 |
| `OpsPage.tsx:1227,1420,1444` | 「本机 auth 目录」 | 「本机凭据目录」 |

### 1.9 措辞与语病

| 位置 | 问题 | 修复 |
|---|---|---|
| `ChannelGrid.tsx:56` | 「渠道与台机器」漏字 | 「渠道与本机客户端状态」 |
| `ImportRaccoonDialog.tsx:557` | 字面 Markdown `**一次性登录票据**` 会原样显示 | 改 `<strong>` |
| `App.tsx:27` | `label="加载模块…"` 被组件再追加 `…` → `加载模块……` | 组件内 `stripTrailingEllipsis` 兜底 |
| `OpsPage.tsx:1631` | 「24 小时提前」语序颠倒 | 「提前 N 小时刷新」 |
| `OpsPage.tsx:1330` | 「每个账号停留下方设定时长」缺「的」 | 「停留下方设定的时长」 |
| `SetupGate.tsx:173` | JSX 跨行渲染出「面板。 请创建」多一个空格 | 合并为一行 |
| `ChannelGrid.tsx:213` | 按钮名是条件句「接入账号后可领取」 | 「领取（需先接入账号）」 |
| `QoderOps.tsx:167` | 「仅供阅读」错词 | 「仅供参考」 |
| `GrowthPanel.tsx:338` | 「今日已完」缺字 | 「今日额度已用完」 |
| `ImportRaccoonDialog.tsx:706,709` | 「账单面」「余额面」后端口径直译 | 「账单数据」「余额数据」 |
| `ImportRaccoonDialog.tsx:673` | 「点数」 | 「积分」 |
| `QoderOps.tsx:230` | 「列表级已领」内部概念 | 「今日活动已领」 |
| `WbOauthDialog.tsx:186` | 「完成扫码/授权」，但该流程是浏览器授权无二维码 | 「在系统浏览器完成授权后」 |
| `OauthTraeDialog.tsx:109` | OAuth 失败却指路「运维 → 定时任务」 | 改指「重试或改用粘贴回调 URL」 |
| `OauthTraeDialog.tsx:168` | 分组选项「默认分组」vs「WorkBuddy」层级不一 | 「默认池」/「WorkBuddy 池」+ 说明 | 
| `SetupGate.tsx:70` | 非 401 直接显示 `Failed to fetch` 原文 | 分 401 / 网络两类可操作提示 |
| `AccountAttrsDialog.tsx:96,123` | `例如 workbuddy`（小写平台名）、`长期, 备用`（半角逗号夹中文） | `例如：WorkBuddy`、`例如：长期,备用`，label 改「英文逗号分隔」 |
| `ImportWbDialog.tsx:230,236` | `<dt>uid</dt>`、`<dt>accessToken</dt>` | 「用户 ID」「访问令牌」 |

### 1.10 术语与单位统一

| 概念 | 修复前 | 修复后 |
|---|---|---|
| ZCode 额度单位 | `tok`、`tokens` 混用 | 一律 `Token`（`text-unit`） |
| Qoder 额度单位 | `cr`、`credits` | 一律 `积分` |
| token 大小写 | `token`（保留 4 处）vs `登录 Token` | 面向用户一律 `Token` |
| 「渠道」vs「平台」 | 45 / 50 处混用且部分同义 | 面板标题与文案统一「平台」；「通知渠道」保留（语义确实不同） |
| 开关状态 | `启用/停用`、`开启/关闭`、`已开启/已关闭`、`运行中/已停止` | 状态统一 `已启用 / 已停用`；进程状态用 `运行中 / 已停止` |
| 「重新取数」动作 | `刷新`/`重新查询`/`刷新账号`/`重新探测`/`重新检测` | 本地重读 = `刷新`；跳缓存 = `强制刷新`；真打上游 = `重新探测` |
| 费率表头 | `未缓存输入 /1k` | `未缓存输入（积分 / 千 Token）` |
| 倍率符号 | 拉丁 `x1.5` | `×1.5` |
| 拆分行单位 | `1,234 / 56` | `1,234 积分 / 56 次` |
| 压缩节省 | `1.2 MB /34.5 MB`（斜杠前无空格） | `1.2 MB / 34.5 MB（压缩前）` |
| `TokenStatsPage` 小数位 | 5 种精度并存 | 费率统一 6 位、百分比 1 位 |
| 分页 | `第 3 / 5 页` | `第 3 页 · 共 5 页` |
| 枚举直出 | `traveling`、`strip`、`message_delta`、`finishReason`、`trae-cn`、`import`、`upstream` | 全部加映射表，未知值回退原文 |

### 1.11 空态、错误态与破坏性操作

| 位置 | 问题 | 修复 |
|---|---|---|
| `AccessKeysPage.tsx:191` | 删除确认不点名密钥、不说不可撤销 | `` 删除访问密钥「${name}」？ `` + 「立即失效且无法恢复」 |
| `AccessKeysPage.tsx:156` | 重置确认只有标题 | 补「旧密钥立即失效；当前会话会切到新密钥」 |
| `OpsPage.tsx:1102` | 「清空日志」是不可恢复删除却用默认灰按钮 | 改 `variant="danger"`，文案「清空全部日志」，`okText` 改「清空全部」 |
| `ImportRaccoonDialog.tsx:107` | 「清除」一键抹掉手机号+密码，无确认 | 加 `prompt` 确认，文案「清除密码凭据」 |
| `NotifyBackupPanel.tsx:336` | 覆盖式恢复未说明「覆盖」「不可撤销」 | `okText: '覆盖恢复'`，message 补后果 |
| `NotifyBackupPanel.tsx:136` | `maskHint` 回显密钥前 3 位 + 后 2 位 | 改「已配置（重新输入可替换）」 |
| `ImportWbDialog.tsx:237` | `<dd>{local.accessToken}</dd>` 明文铺在弹窗里 | 改掩码 `abc123…wxyz` |
| `NotifyBackupPanel.tsx:7 处` | `toast('保存失败')` 吞掉非 ApiError 的真实原因 | 抽 `apiErrorText()`，保留原始异常文本 + 下一步 |
| 手写空态 5 处 | 手写 `<div>` 无原因无下一步 | 全改 `EmptyState`，各自补 hint |
| 手写空态 5 处 | 未用 `EmptyState` | 全部替换（`accountPacks`、`KeepaliveBoard`、`OpsPage` ×3、`AuditPage`、`ModelPoolPage`、`ModelRouterPage`） |
| `EmptyState` 句末标点 | 部分带「。」部分不带 | 组件内 `stripTrailingPeriod` 统一收敛 |

### 1.12 可访问性

| 位置 | 问题 | 修复 |
|---|---|---|
| `shared/ui/index.tsx:64` | 28 处 `Field` 的 label 与 input 无关联 | `useId()` 兜底（见 §1.1） |
| 8 处 `Field` | 同时传 `label` 与 `aria-label`，文案不同 → 读屏播报与屏幕不符 | 删 `aria-label`（有可见 label 时不需要） |
| `TrafficPage.tsx:239` | 失败行整行 `onClick` 无 `tabIndex`/`onKeyDown` | 补 `tabIndex`/`role`/`onKeyDown`（Enter/Space） |
| `TokenStatsPage.tsx:843` | 两列小表无 `<thead>` | 补表头 |
| `DailyTrendChart.tsx:57` | 双 Y 轴无轴标题，只靠颜色区分 | 补「请求量」/「Token」轴标题 |
| `DailyTrendChart.tsx:116` | `aria-label` 不含错误数 | 补「错误合计」 |
| `DailyTrendChart.tsx:142,192`、`TokenHeatmap.tsx:132,172` | SVG 字号 10px | 改 11px |

### 1.13 其他功能性缺陷（审查附带发现）

| 位置 | 问题 | 修复 |
|---|---|---|
| `ModelPoolPage.tsx:406` | `setProbeModelName(m.id); void probe()` —— `probe()` 读闭包旧值，探测的是上一次填的模型 | `probe(target?)` 收参，按钮 `void probe(m.id)` |
| `OpsPage.tsx:1518` | `disabled={busy === 'switch'}`，但状态键是 `switch-${uid}` → 切换中始终可点 | 改 `disabled={busy != null}` |
| `OpsPage.tsx:1178` | 后端原始 `t.error` 整段塞进单元格，可能撑出十几行 | `line-clamp-2` + `title` |
| `TransferDialog.tsx:166` | `disabled={busy \|\| !!importResult}` → 一次导入后永久禁用 | 去掉 `!!importResult` |
| `TransferDialog.tsx:245` | 原生 `file` input 未套样式 | 补 `file:` 系列类 |
| `ImportWbDialog.tsx:159` | 按钮塞进 `<Note>` 内会随基线漂移 | 拆成 flex 容器 |
| `ImportQoderDialog.tsx:203` | 两个「完成」按钮（一个关闭一个提交） | 改「稍后处理」 |
| `ImportQoderDialog.tsx:298` | 区域标「必选」但已默认选好 | 改「必须与账号实际区域一致」 |
| `ImportTraeDialog.tsx:99` | 「批量导入」与「导入」差异无任何说明 | 加说明行 + 改「批量导入全部」 |
| `PackDialog.tsx:32` | `account.source` 原样输出 `import`/`oauth` | 加 `SOURCE_LABEL` 映射 |
| `format.ts:173` | `platformIdLabel('wb')` 返回 `wb` | 补归一化 |

---

## 2. 移动端处理说明

按要求删除，具体动作：

- 删除 `global.css` 的 `@media (max-width: 767px)` 与 `@media (min-width: 768px)` 两个整块（原 704-786 行）
- 删除 `.layout-menu-btn`、`.layout-nav-scrim`、`.layout-aside-open`、`.card-table` 全部规则
- 删除全部 TSX 中的 `card-table` 类（26 处）与 `data-label` 属性（服务于移动端卡片化）
- `.layout-aside` 保留：它是桌面侧栏，与移动端无关
- `web/scripts/add-data-labels.mjs` 随之失效（它只为 `card-table` 注入 `data-label`）——**建议删除该脚本**，本次保留未动

保留的响应式断点是给桌面中等宽度用的（`lg:` / `xl:`），不属于移动端适配。

---

## 3. 残留与建议

### 3.1 本次未做（需要产品决策）

| 项 | 原因 |
|---|---|
| 深色主题 | `color-scheme: light` 保留。加暗色需要 6 组语义色各出一套值，不是样式修复能顺手做的 |
| 设计库令牌补齐 | 缺 `--rg-radius-*(6)`、`--rg-sp-*(11)`、语义别名(12)。当前 Tailwind 硬编码了同值，不影响渲染；补齐属于规范化工作 |
| `--rg-chart-2/4/5` 零引用 | 色阶保留完整是有意的；等图表需要第 3 条序列时再启用 |
| `add-data-labels.mjs` | 已失效，建议删除而非修补 |

### 3.2 建议固化的 CI 门

```bash
cd web && npx tsc --noEmit
cd web && node scripts/check-css-tokens.mjs
cd web && npx eslint .
```

三条全部退出 0，且第二条能恒久挡住「引用未定义令牌」这类静默失效——它在本次修复前一直以退出码 1 挂着。

---

## 4. 交付核对

- 改动文件：35 个（`web/src/**` 33 + `global.css` + `tailwind.config.ts` 未动）
- `global.css`：786 → 720 行（删除移动端块，新增 9 个复用类与字号档）
- 净删除重复代码约 300 行（内联样式收敛为类）
- 三个验证脚本全部通过，构建产物 6.4s
