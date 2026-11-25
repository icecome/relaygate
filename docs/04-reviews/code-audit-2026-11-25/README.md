# RelayGate 全仓代码审计与安全审计报告

> **审计对象：** `C:\opt\workstations\project\web\RelayGate`（v3.1.0）
> **审计日期：** 2026-11-25
> **审计范围：** 后端 `src/`（172 个非测试 JS，42,773 行）、前端 `web/src/`（80 个 TS/TSX，24,945 行）、`scripts/`（113 个）、配置与依赖清单
> **审计方式：** 核心模块逐行精读（52 个文件）+ 全仓危险模式扫描（100%）+ 依赖漏洞扫描（`npm audit`）+ 关键漏洞动态复现（Node v24 实机）
> **报告用途：** 可直接用于整改派工与整改后验证

---

## 目录

| 章节 | 文件 | 内容 |
|------|------|------|
| 0-1 | [本文 §0-1](#0-审计范围与覆盖度声明) | 范围、覆盖度、风险总览、负向结论 |
| 2 | [`02-high.md`](./02-high.md) | 高危 4 项（H-01 ~ H-04） |
| 3 | [`03-medium.md`](./03-medium.md) | 中危 6 项（M-01 ~ M-05、M-07；M-06 已核验否定） |
| 4 | [`04-low.md`](./04-low.md) | 低危 8 项（L-01 ~ L-08） |
| 5 | [`05-info.md`](./05-info.md) | 提示 5 项（N-01 ~ N-05） |
| 6 | [`06-file-inventory.md`](./06-file-inventory.md) | 分文件问题清单（8 个模块分组） |
| 7 | [`07-additional.md`](./07-additional.md) | 补充发现（N-06、N-07） |
| 8 | [`08-priority.md`](./08-priority.md) | 整改优先级 P0/P1/P2/P3 + 依赖关系 |
| 9 | [`09-hardening.md`](./09-hardening.md) | 安全加固建议汇总 + 验证清单 |
| 10 | [`10-appendix.md`](./10-appendix.md) | 覆盖度明细、核验方法、架构正向评价 |

---

## 0. 审计范围与覆盖度声明

本报告严格区分「已逐行核验」与「已模式扫描」，不做无证据的推断。

| 范围 | 文件数 | 覆盖方式 | 覆盖度 |
|------|--------|----------|--------|
| `src/` 非测试代码 | 172 | 52 个逐行/大段精读；全量正则扫描 100% | 精读 30%，扫描 100% |
| `src/test/` | 31 | 仅作隔离性抽查，不纳入缺陷评级 | 抽查 |
| `web/src/` | 80 | 本人精读 6 个 + 子代理覆盖约 13 个（部分全文、部分关键段）+ 关键点自行复核；全量扫描 100% | 精读约 20%，扫描 100% |
| `scripts/` | 113 | 全量扫描；`probes/`（79 个）按模式归纳 | 扫描 100% |
| 配置/依赖 | `package.json`、`package-lock.json`、`biome.json`、`model-*.json`、`.env.example` | 全读 + `npm audit` | 100% |

**已排除（非项目源码）：** `node_modules/`、`web/dist/`（构建产物）、`.history/`（历史快照）、`logs/`、`backups/`、`output/`（运行期数据）、`design/`。

**未覆盖缺口（详见附录 A.2）：** `src/` 中约 120 个文件仅扫描未逐行（最大者为 `jobs/scheduler.js` 1116 行）；`web/src` 中约 40 个文件未读（含 `app/`、`features/stats`、`shared/ui`、`shared/lib`）。**这些文件的"无缺陷"结论未成立。**

---

## 1. 项目整体风险概览

### 1.1 风险总评

**综合评级：🟠 中等偏高（MEDIUM-HIGH）**

架构设计成熟度显著高于同规模自托管网关：密钥分域（K-1 管理/转发分离）、scope + 资源 ACL 双层、AES-256-GCM + 持久化密钥 + 启动期密钥失配熔断、SQL 全参数化、乐观锁防丢失更新、错误信息面向客户端泛化。这些是**真实落地**的，不是文档修辞（详见附录 C）。

风险集中在三类：

1. **同类端点防护不一致** —— 两个最高危的问题都不是"没想到"，而是"同类实现里漏了一处"：备份路径校验漏了 `verifyBackup`；限流漏了 Qoder 转发端点（且注释已宣称有）。
2. **依赖 override 锁定了仍含漏洞的版本** —— `qs` 被 `overrides` 钉在 `6.16.0`，而该版本正处于受影响区间，这会阻断 `npm audit fix` 的正常升级路径。
3. **凭据治理的旁路** —— 生产代码反向依赖 `logs/_wb-plain/` 下的明文 token 缓存，且该明文已实际落盘超过一个月。

### 1.2 问题统计

| 等级 | 数量 | 编号 |
|------|------|------|
| 🔴 严重 | 0 | — |
| 🟠 高危 | 4 | H-01 ~ H-04 |
| 🟡 中危 | **6** | M-01 ~ M-05、M-07（M-06 已核验否定） |
| 🔵 低危 | 8 | L-01 ~ L-08 |
| ⚪ 提示 | 7 | N-01 ~ N-07 |

### 1.3 风险分布

| 维度 | 高危 | 中危 | 低危 | 主要落点 |
|------|------|------|------|----------|
| 访问控制 / 授权 | 1 | 1 | 1 | `routes/admin-jobs.js`、`middleware/auth.js` |
| 资源耗尽 (DoS) | 2 | 3 | 0 | `routes/qoder.js`、依赖链、`session/sticky.js`、`credentials/transfer.js` |
| 敏感数据保护 | 1 | 1 | 3 | `logs/_wb-plain/`、`lib/crypto.js`、`lib/mask.js`、`notify/settings.js` |
| 注入类 | 0 | 0 | 0 | **无 SQL/命令/模板注入（已验证）** |
| 反序列化 | 0 | 1 | 0 | `credentials/transfer.js` gunzip 无上限 |
| 加密实现 | 0 | 1 | 0 | `lib/crypto.js#normalizeKey` |
| 可维护性 / 架构 | 0 | 0 | 4 | 超大文件、注释漂移 |

### 1.4 最需立即关注的两件事

1. **`logs/_wb-plain/` 中 8 个账号的 accessToken / refreshToken 已明文驻留磁盘超过一个月**（H-04）。这不是理论风险——应视为已泄露，必须轮换。
2. **`npm audit` 报 `body-parser` high 漏洞，而 `overrides.qs` 把依赖钉在漏洞版本上**（H-03）。修复成本极低（删 override + 升级），但影响所有请求的解析路径。

### 1.5 已验证"不存在"的高危项（负向结论）

以下为本次**明确排查并确认未发现**的风险，用于缩小后续复审范围：

- **SQL 注入：** 全仓仅 2 处动态 SQL 拼接，列名均来自静态白名单（`credentials/store.js:364` 的 `PATCH_COLUMNS`、`jobs/backup.js:437` 的列常量），值全部走 `?` 占位符。**无注入面。**
- **命令注入：** `child_process` 调用全部为 `execFileSync`/`execFile` 数组传参（`schtasks`、`powershell.exe` 固定脚本）或**不含变量插值**的静态 `execSync` 字符串。`zcode/captcha.js` 的 `spawn` 亦为数组传参。**无注入面。**
- **XSS：** 前端 `dangerouslySetInnerHTML`/`innerHTML`/`document.write`/`eval`/`new Function` 命中数为 **0**；`qr.js:528` 与 `raccoon.js:255` 的命中是**注释**在解释为何不用。唯一动态 `href`（`ImportRaccoonDialog.tsx:583`）配 `rel="noreferrer noopener"`。
- **反序列化 RCE：** 无 `node-serialize`/危险 YAML 加载/`vm` 沙箱逃逸面；`JSON.parse` 均为纯数据解析。
- **原型污染：** 无递归合并用户输入；`Object.assign` 仅用于常量头合并。
- **开放重定向：** 唯一 `res.redirect` 是 `routes/dashboard.js:11` 的固定字面量 `/`。
- **TLS 校验关闭：** 无 `rejectUnauthorized:false`、无 `NODE_TLS_REJECT_UNAUTHORIZED`。
- **凭据硬编码（生产代码）：** `src/` 内无硬编码 token/密码；`.env` 未被 Git 跟踪，仅 `.env.example` 入库且值为空。
- **时序攻击（DB 密钥路径）：** `verifyAccessKey`/`verifyLoginKey` 走 `key_hash` 索引等值查询，不做明文比较。

---

## 2. 高危问题速览

完整分析见 [`02-high.md`](./02-high.md)。

| 编号 | 文件:行 | 问题 | 可利用性 |
|------|---------|------|----------|
| **H-01** | `src/routes/admin-jobs.js:131` / `src/jobs/backup.js:303` | 备份校验端点绕过路径闸门 → 任意文件读取 + 错误回显内容前缀 | 需管理员凭据 |
| **H-02** | `src/routes/qoder.js:418` | Qoder 对话转发缺 `keyRateLimit()`，注释却宣称有 → 无限速烧穿真实积分 | 需合法 access key |
| **H-03** | `package.json:59-61` | `overrides.qs=6.16.0` 锁定漏洞版本；`body-parser@1.20.8` 有 high CVE | 无需凭据（DoS） |
| **H-04** | `src/jobs/rotate-seed.js:120` / `scripts/wb-decrypt-auth.js:118` | 生产代码依赖 `logs/_wb-plain/` 明文 token；8 个账号凭据已明文落盘 >1 个月 | **已实际发生** |

---

## 3. 中危 / 低危 / 提示 速览

**中危（6）** —— 详见 [`03-medium.md`](./03-medium.md)

| 编号 | 文件:行 | 问题 |
|------|---------|------|
| M-01 | `src/lib/crypto.js:44-47` | `normalizeKey` 对非 hex 静默返回 0 字节、对短密钥补零 |
| M-02 | `src/session/sticky.js:9,22,60` | 粘性 Map 无容量上限，攻击者可控请求头无限注入 |
| M-03 | `src/credentials/transfer.js:118` | `gunzipSync` 无输出上限（解压炸弹） |
| M-04 | `web/src/features/accounts/AccessKeysPage.tsx:66` | `SecretBox` 明文密钥无遮蔽渲染，揭示无二次确认 |
| M-05 | `src/middleware/auth.js:70-84` | 管理面无失败限速、失败不入审计 |
| ~~M-06~~ | `src/lib/sse-heartbeat.js` | **已核验否定** —— `unref()` 与 `stop()` 路径完整，无缺陷 |
| M-07 | `src/routes/admin-jobs.js:132` 等 | 管理面直接回 `err.message`；全局 4xx 分支透传 `err.message` |

**低危（8）** —— 详见 [`04-low.md`](./04-low.md)

| 编号 | 位置 | 问题 |
|------|------|------|
| L-01 | `middleware/auth.js:39` | `isEnvLogin` 用 `===` 比较（非恒定时间） |
| L-02 | `log/traffic.js:51` | 脱敏按键名匹配，无值特征兜底；`maskSecret` 阈值偏低 |
| L-03 | `index.js:333` | 4xx 分支回显 `err.message`（含请求体片段） |
| L-04 | `scripts/verify/verify-review-fixes.js:94` | 疑似真实手机号 + 密码字面量 |
| L-05 | `routes/api-keys.js:73,92` / `credentials/api-keys.js` | `label` 无长度上限、无类型归一 |
| L-06 | 5 处 `eslint-disable exhaustive-deps` | 闭包捕获过期值；`useAsyncData` 变长依赖数组 |
| L-07 | 7 个 >800 行文件 | 可维护性（Divergent Change） |
| L-08 | `routes/qoder.js:6-9`、`config.js:247` | 注释与实现漂移；`toolProtocol` 为死配置 |

**提示（7）** —— 详见 [`05-info.md`](./05-info.md) 与 [`07-additional.md`](./07-additional.md)

`Math.random` 用于非安全 ID（N-01）、SSE 出向帧未收敛（N-02）、`config.reload()` 字段重复（N-03）、`admin.ts` 876 行（N-04）、无 CI / `.editorconfig`（N-05）、通知凭据明文落盘（N-06）、`probes/` 缺边界声明（N-07）。

---

## 4. 整改优先级（摘要）

完整版含验证命令见 [`08-priority.md`](./08-priority.md) 与 [`09-hardening.md`](./09-hardening.md)。

### P0 — 24 小时内（2 项）

| 编号 | 动作 |
|------|------|
| **H-04** | ① 删除 `logs/_wb-plain/` ② **轮换全部涉及账号的 refreshToken**（视为已泄露）③ 移除 `rotate-seed.js:120-130` 明文分支 |
| **H-03** | ① 删 `overrides.qs` ② 升 `body-parser>=1.20.9` ③ 升 `express>=4.22.3` ④ CI 加 `npm audit --audit-level=high` |

> **H-04 必须先于代码修改轮换 token**，否则轮换后的新 token 会被重新写进明文目录。

### P1 — 一周内（3 项）

| 编号 | 动作 |
|------|------|
| **H-01** | `verifyBackup` 首行调 `resolveBackupPath`，去掉 `e.message` 回显（约 3 行改动） |
| **H-02** | `router.post('/chat/completions', authenticate, keyRateLimit(), ...)` + 守门测试 |
| **M-04** | `SecretBox` 默认掩码 + 限时显示 + 揭示确认 |

### P2 — 一个迭代（5 项）

`M-01`、`M-02`、`M-03`、`M-05`、`M-07`

### P3 — 择机

`L-01`~`L-08`、`N-01`~`N-07`。建议"顺手改"：下次改动相关文件时一并处理。优先 `L-02`（5 行改动，防未来 fail-open）与 `L-08`（修 H-02 时同步改注释）。

---

## 5. 安全加固的核心结论

完整版见 [`09-hardening.md`](./09-hardening.md)。这里只保留最重要的一条观察：

> **H-01 与 H-02 都是"同类实现漏了一处"，不是"不知道要做"。**

这指向同一个根因：同类端点的防护靠**逐处手写**，没有机制保证。

具体到限流：转发面有 5 个入口，其中 3 个（`/v1/chat/completions`、`/v1/messages`、`/v1/responses`）由 `index.js:298` 的 `app.use(rateLimitMw)` 统一覆盖；另 2 个（`/v1/qoder/*`、`/v1/raccoon/*`）因挂在独立前缀下，必须在各自路由内手写 `keyRateLimit()`。Raccoon 挂对了，Qoder 漏了。**同一件事有 2 种装配方式，就一定会有遗漏**。

因此**投入产出比最高的建议是**：把"同类端点一致性"变成可测断言。仓库已有 `src/test/wiring.test.js` 的先例，建议扩充为"路由契约测试"——遍历 `app._router.stack`，断言：

- 每个 `/v1/admin/*` 路由的中间件链都含 `authenticateAdmin`；
- 每个转发路由（含独立前缀下的）都含 `keyRateLimit`；
- 每个接收文件路径的端点都经过闸门函数。

这条测试一旦存在，H-01 与 H-02 这类问题在提交时就会被拦住，而不是等到下一次审计。

---

## 6. 审计可信度声明

### 6.1 核验分层

每条结论都经过至少两层验证：模式扫描 → 数据流追踪 → （关键项）动态实机复现 → 反向找反证。

### 6.2 主动撤回的 3 条误报

本次审计中，3 条初始疑点经核验后**确认不成立并已撤回**，记录在案以免后续重复投入：

| 原疑点 | 撤回依据 |
|--------|----------|
| M-06 SSE 心跳定时器泄漏 | `lib/sse-heartbeat.js:132` 有 `timer.unref()`；`stop()` 三路覆盖完整 |
| L-08 第 2 点 `isDocumentRoute` 注释漂移 | `index.js:164` 实现与 `:163` 注释完全一致 |
| `/scheduler/:action` 无 action 白名单 | `admin-jobs.js:22-43` 有显式 if 链白名单 |

### 6.3 本报告不成立的结论

**本报告未对以下内容作出判断**（因未覆盖或超出范围）：

- 业务逻辑正确性（如积分计算是否与实际账单一致、费率标定准度）——需对账验证，非静态审计可覆盖；
- `src/jobs/scheduler.js` 等 120 个仅扫描文件的逻辑缺陷；
- 前端约 40 个未读文件的渲染/竞态问题；
- 上游协议实现的正确性（Qoder COSY 协议、WorkBuddy 加密信封格式等）——需协议对照，非安全审计范围。

---

*报告生成：2026-11-25 ｜ 审计基线：`git HEAD 1ec3e9b`*
