# RelayGate 前端重构设计方案

适用范围：`web/` 下的 Vite + React 管理端。本文档为设计方案，用于指导后续重构实施与画布预览产出。

## 1. 现状基线

### 1.1 技术栈

| 层面 | 当前版本 | 备注 |
| --- | --- | --- |
| 视图层 | React 18.3.1 + React DOM 18.3.1 | 函数组件为主，未引入状态管理库 |
| 路由 | React Router DOM 6.28.0 | 4 个主路由 + 2 个参数化子页 |
| 构建 | Vite 5.4.11 | 未配置路由级代码分割 |
| 类型 | TypeScript 5.6.3 | `tsc --noEmit` 通过，未发现 `any` / `@ts-ignore` |
| 样式 | Tailwind CSS 3.4.15 | 少量手写全局样式在 `index.css` |
| 质量 | ESLint 9.39.5 | `eslint .` 0 error / 0 warning |

后端为 Node >= 22.5 + Express 4.21.0，本次重构不改后端契约。

### 1.2 代码结构

前端共 63 个 `.ts/.tsx` 文件，约 8700 行，目录职责基本清晰：

- `api/`：接口封装，`admin.ts` 约 578 行，为当前最大文件
- `lib/`：`api.ts`（请求封装）、`format.tsx`（格式化）、`nav.ts`（导航）、`ops.ts`（操作辅助）、`store.ts`、`useHeartbeat.ts`
- `components/`：通用组件与面板
- `pages/`：页面与页面私有子组件
- `stores/`：`useAuth`、`useExpiryWindow`、`useSummary`

### 1.3 主要问题

按影响面排序：

1. 重复请求：`useSummary` 基于组件级 `useState`，Overview、GrowthPanel、AccountsPanel、LogsSection 等多个消费者各自请求 `/summary`，缺少共享缓存与请求合并。
2. 请求层能力不足：`lib/api.ts` 缺少 `AbortSignal`、超时、取消与重试；`ApiError` 未完整保留后端 `code` 与 `type`，前端难以区分业务失败与网络失败。
3. 渲染开销：`Overview.tsx` 每秒 `setInterval` 触发 `setState`，导致整页重渲染，仅为刷新相对时间。
4. 首屏体积：没有 `React.lazy` + `Suspense`，所有页面与图表代码进入主包。
5. 组件粒度失衡：`ModelRouterPage.tsx` 465 行、`GrowthPanel.tsx` 454 行、`SettingsTasks.tsx` 415 行、`SettingsNotify.tsx` 408 行，表单、请求与渲染混在单文件。
6. 日志列表无长度上限，长时间运行后 DOM 无界增长。
7. 交互契约不完整：`RowMenu` 注释声明支持方向键但实现只处理 `Escape`；`SourceSwitch` 使用 `radiogroup` 语义但缺少方向键与 roving tabindex。
8. 状态反馈缺口：部分异步操作只有按钮禁用，缺少加载态、错误态与空状态三件套。
9. 统计页结构重复：Token 与积分统计页面存在大量重复数据请求与近似 UI 结构。

### 1.4 业务约束（重构必须尊重）

- 账号状态取值为 `off / cool / ok`，不可用 `0` 之类的假值替代。
- `unlimited` 权益包不能用数值 `0` 表达，需要独立的显示与判定逻辑。
- 轮换类接口可能返回业务层 `ok:false`，属于正常业务结果，不应一律按异常处理。
- `/v1/admin/debug/sse` 读取的是落盘 JSONL，并非实时流，UI 文案与刷新策略需要贴合真实语义。
- 长任务（成长自动化、OAuth 登录、批量签到与余额刷新、备份、轮换、探活）需要进度反馈与可取消入口。

## 2. 目标架构

### 2.1 分层

```text
app/            路由、布局、全局 Provider、错误边界
features/       按业务域拆分的页面与私有组件
  overview/
  accounts/
  model-router/
  stats/
  runtime/
  settings/
  logs/
shared/
  api/          请求内核 + 领域接口 + 错误模型
  ui/           无业务语义的基础组件
  hooks/        通用 hooks
  lib/          格式化、常量、纯函数
styles/         tokens 与全局样式
```

### 2.2 请求层

- `shared/api/http.ts`：`fetch` 封装，注入 `AbortSignal`、超时、请求去重、有限重试（仅对幂等 GET 与网络错误生效），统一解析 `ApiError`（保留 `code`、`type`、`message`、`details`）。
- `shared/api/endpoints/*.ts`：按领域拆分现有 `admin.ts`，保持 URL、请求方法与请求体字段完全不变。
- 领域请求统一返回显式类型，避免调用方到处断言。

### 2.3 状态管理

不引入新的第三方状态库，沿用 React Context + Reducer：

- `SummaryProvider`：单一 `/summary` 数据源，内置请求合并、轮询节流、失效重取，页面按字段订阅。
- `AuthProvider`：沿用现有登录密钥语义，保持清理时机不变。
- `ServerStateProvider`：长任务进度、探活状态与轮换结果的集中管理，配 `useTask()` 统一处理长任务生命周期。
- 局部 UI 状态保持在组件内，派生值通过选择器计算，不落 state。

### 2.4 组件体系

基础组件层（`shared/ui`）：`Button`、`Input`、`Select`、`Switch`、`Checkbox`、`Badge`、`Table`（列定义 + 虚拟滚动）、`Tabs`、`Modal`、`Drawer`、`Toast`、`EmptyState`、`ErrorState`、`Skeleton`、`Stat`、`Sparkline`。

模式层（`shared/patterns`）：`PageShell`（页头 + 工具条 + 内容区）、`FilterBar`、`DataToolbar`、`TaskProgress`、`ConfirmDialog`、`KeyReveal`、`EmptyHint`。

拆分原则：请求与副作用集中在容器组件，展示组件保持纯函数，便于测试与复用。

## 3. 页面映射

| 页面 | 路由 | 职责 |
| --- | --- | --- |
| 态势总览 | `/` | 全局读数、账号健康分布、模型路由概览、长任务与告警摘要 |
| 账号池 | `/accounts/:tab` | 账号与卡片双视图、批量操作、导入、OAuth、余额额度、签到成长、访问密钥 |
| 模型路由编排 | `/model-router` | 供应商与虚拟模型配置、候选健康度、自动分层、优先级调整 |
| 统计分析 | `/stats/:tab` | Token 与积分消耗趋势、模型分布、日志分析 |
| 运行状态 | `/status` | 服务健康、探活、转发面与后端运行信息 |
| 设置与运维 | `/settings/:tab` | 调度任务、通知、配置与备份 |
| 日志流 | `/stats/logs` | 客户端日志、审计日志、任务日志的检索与过滤 |

画布节点 ID 依次为：`page-overview`、`page-accounts`、`page-model-router`、`page-stats`、`page-runtime`、`page-settings`、`page-logs`。

## 4. 视觉语言

方向为「工程纸面规格书」，与产品功能隐喻一致：运维控制台 + 数据密集型规格文档。

- 底色：米白到暖灰纸面，弱纹理感，不用纯白高对比。
- 文字：墨黑为主，分级用字重与字号建立，避免过多色相。
- 结构：发丝级分割线、紧凑网格、右对齐等宽数字读数。
- 信号色：单一墨绿作为唯一强调色，用于活跃、成功、主操作；红黄仅承担告警语义。
- 表格：等宽数字、表头小字加字距、行分隔线，弱化斑马纹。
- 图形：细描边折线与柱状为主，避免大面积渐变与装饰性大圆角。
- 字体：标题走克制的编辑式层级，正文用中文系统无衬线，数字与代码用等宽字体。
- 明确不做：蓝紫科技感、彩虹分类色、深浅色切换、响应式断点设计。

## 5. 性能优化清单

1. `SummaryProvider` 合并重复请求，消除多组件重复拉取。
2. 概览页相对时间刷新从整页 `setInterval` 改为局部订阅，缩小到具体读数组件。
3. 路由级 `React.lazy` + `Suspense`，图表与弹窗组件按需加载。
4. 账号与日志长列表采用窗口化渲染，并设置条目上限与清理策略。
5. `useMemo` / `useCallback` 用于表格列定义、行数据派生与图表数据集。
6. 请求去重与取消：路由切换时中止在途请求，避免竞态覆盖。
7. 静态资源分包：把 `charts`、导入/编辑弹窗归入独立 chunk。

## 6. 迁移阶段

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| P0 | 方案落地与画布预览 | 本文档 + 7 页预览页面 |
| P1 | 请求层重建 | `shared/api` 内核 + 领域拆分 + 错误模型 |
| P2 | 状态层合并 | `SummaryProvider`、`ServerStateProvider`、长任务 hook |
| P3 | 组件体系 | `shared/ui` 与 `shared/patterns` 落地，替换旧组件 |
| P4 | 页面重构 | 7 个页面按新结构重写，逐页对齐预览 |
| P5 | 性能与体验收尾 | 代码分割、窗口化、空/错/加载三态、快捷键与焦点治理 |
| P6 | 验收 | `tsc --noEmit`、`eslint .`、`npm run build` 全通过 |

迁移期间保持后端 URL、方法与字段不变，前端逐页切换，不做一次性整体替换。

## 7. 风险与应对

| 风险 | 应对 |
| --- | --- |
| 业务字段语义被误改（`unlimited`、`ok:false`、`off/cool/ok`） | 抽取统一的展示与判定工具函数，编写针对边界值的用例 |
| 请求层重写引入竞态 | 中止信号贯穿组件生命周期，配合取消请求用例 |
| 长列表窗口化影响既有交互 | 保留行菜单与详情弹窗入口，先在单页验证再推广 |
| 一次性改动过大难以回滚 | 按 P1 到 P6 分阶段提交，每阶段独立可构建可运行 |

## 8. 验收标准

1. `npx tsc --noEmit` 零错误。
2. `npx eslint .` 零错误零警告。
3. `npm run build` 成功，路由级 chunk 生效。
4. 7 个功能页面的核心业务能力与重构前一致，无功能回退。
5. 概览页 `/summary` 请求在一次会话内不再重复并发。
6. 长列表页面在万级数据量下滚动稳定，无卡顿与内存无界增长。
7. 所有异步区域具备加载、错误、空三态。
8. 键盘可达性：`RowMenu` 与 `SourceSwitch` 的方向键行为与注释声明一致。