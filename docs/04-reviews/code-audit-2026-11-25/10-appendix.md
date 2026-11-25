## 附录 A — 覆盖度明细与未覆盖缺口

### A.1 逐行精读的文件清单（52 个）

**入口与配置（4）**
`src/index.js`、`src/config.js`、`package.json`、`.env.example`

**鉴权与访问控制（6）**
`src/middleware/auth.js`、`src/middleware/model-access.js`、`src/middleware/rate-limit.js`、`src/auth/scope.js`、`src/routes/api-keys.js`、`src/credentials/api-keys.js`

**凭据与加密（8）**
`src/lib/crypto.js`、`src/lib/atomic-write.js`、`src/lib/mask.js`、`src/lib/paths.js`、`src/lib/settings-store.js`、`src/credentials/store.js`、`src/credentials/transfer.js`、`src/jobs/backup.js`

**备份与轮换（2）**
`src/jobs/rotate-seed.js`、`src/jobs/rotate-accounts.js`（部分）

**转发链路（6）**
`src/routes/openai.js`、`src/routes/responses.js`、`src/routes/qoder.js`（头+端点表）、`src/routes/raccoon.js`（端点表）、`src/model-router/dispatch.js`（部分）、`src/model-router/store.js`（部分）

**会话与日志（5）**
`src/session/sticky.js`、`src/lib/sse-heartbeat.js`、`src/lib/upstream-error.js`、`src/log/traffic.js`、`src/log/audit.js`

**其他核心（7）**
`src/lib/startup-checks.js`、`src/credentials/db.js`（部分）、`src/credentials/oauth.js`（部分）、`src/qoder/crypto.js`、`src/notify/index.js`、`src/notify/settings.js`、`src/routes/status.js`

**前端（6）**
`web/src/features/accounts/AccessKeysPage.tsx`、`web/src/features/accounts/CredentialsPage.tsx`（规模与结构）、`web/src/features/accounts/WbOauthDialog.tsx`（轮询段）、`web/src/shared/api/auth.ts`、`web/src/shared/hooks/useAsyncData.ts`、`web/src/features/accounts/ImportRaccoonDialog.tsx`（href 段）

**脚本（2）**
`scripts/wb-decrypt-auth.js`、`scripts/verify/verify-review-fixes.js`（字面量段）

### A.2 仅模式扫描、未逐行阅读的文件（明确缺口）

以下文件已通过全仓正则扫描排除高危模式（`eval`/`new Function`/`innerHTML`/SQL 拼接/命令注入/`rejectUnauthorized:false`），但**未逐行核验逻辑缺陷**。它们的"无缺陷"结论**未成立**。

| 文件 | 行数 | 未覆盖风险类型 |
|------|------|----------------|
| `src/jobs/scheduler.js` | 1116 | 定时任务并发、时区边界、任务重叠 |
| `src/credentials/pool.js` | 946 | 选号公平性、冷却竞态（部分已读） |
| `src/platform/variant.js` | 823 | 常量表正确性（低风险） |
| `src/model-router/dispatch.js` | 817 | 候选切换状态机（部分已读） |
| `src/raccoon/product.js` | 673 | 上游协议映射 |
| `src/routes/raccoon.js` | 659 | 端点实现细节 |
| `src/model-router/index.js` | 649 | 路由决策 |
| `src/routes/credentials.js` | 569 | 账号 CRUD 细节 |
| `src/raccoon/auth.js` | 563 | 认证流程 |
| `src/workbuddy/cat-trip.js` | 545 | 活动接口 |
| `src/raccoon/limiter.js` | 507 | 限流器实现 |
| `src/raccoon/credits.js` | 501 | 积分计算 |
| `src/upstream/client.js` | 472 | SSE 处理细节 |
| `src/zcode/rewards.js` | 416 | 奖励领取 |
| `src/log/client-logs.js` | 409 | 日志解析 |
| 其余 `src/` 约 100 个文件 | — | 各模块细节 |

**前端未读（约 40 个）：**
`web/src/app/*`（4）、`web/src/features/stats/*`（5）、`web/src/features/security/*`（1）、`web/src/features/setup/*`（1）、`web/src/features/ops/OpsPage.tsx` 与 `NotifyBackupPanel.tsx`、`web/src/shared/ui/*`（7）、`web/src/shared/lib/*`（6）、`web/src/features/accounts/*` 其余 20 个、`web/src/features/models/*` 其余 2 个、`web/src/lib/store.ts`。

**脚本未读：** `scripts/probes/` 79 个（按模式归纳，未逐个阅读）、`scripts/ops/` 8 个、`scripts/verify/` 约 20 个。

### A.3 后续建议的审计补充

若需提升覆盖度，建议按以下顺序投入（按"缺陷密度 × 影响面"排序）：

1. `src/jobs/scheduler.js` —— 1116 行、6 类定时任务、涉及签到与保活（真实积分），且是并发问题的天然温床。
2. `src/credentials/pool.js` —— 选号是转发面核心，966 行。
3. `src/raccoon/limiter.js` + `src/raccoon/credits.js` —— 积分与限流，直接影响额度安全。
4. `web/src/shared/ui/*` + `web/src/shared/lib/*` —— 13 个文件但被全站复用，XSS/渲染缺陷的影响面最大。
5. `scripts/ops/*` —— 会被实际运行的运维脚本（相对 `probes/` 优先级更高）。

---

## 附录 B — 本次审计的核验方法

为避免"看起来像漏洞就报告"，本次对每条结论采用了分层验证：

| 层级 | 方法 | 应用 |
|------|------|------|
| L1 模式扫描 | 正则全仓扫描危险 API | SQL 拼接、命令执行、`eval`、`innerHTML`、`rejectUnauthorized` |
| L2 数据流追踪 | 从用户输入追到 sink | H-01（`req.query.path` → `readFileSync`）、H-02（route → middleware 链） |
| L3 动态验证 | Node 实机执行验证行为 | `normalizeKey('short')` → Buffer 长度 0；`JSON.parse('SUPER_SECRET...')` → 回显前缀；`npm audit` 实际版本 |
| L4 反向核验 | 对每条结论找反证 | M-06（疑心跳泄漏）→ 查证 `unref()` 存在 → **撤回**；L-08 第 2 点（疑 CSP 注释漂移）→ 查证实现一致 → **撤回**；`/scheduler/:action`（疑无白名单）→ 查证有 if 链 → **排除** |

**撤回记录（3 条）**：

| 原疑点 | 撤回原因 |
|--------|----------|
| M-06 SSE 心跳定时器泄漏 | `lib/sse-heartbeat.js:132` 有 `timer.unref()`；`res.end` 包装调 `stop()`；异常路径 `catch` 内 `stop()`。**实现无缺陷** |
| L-08 第 2 点 `isDocumentRoute` 注释漂移 | `:164` 实现与 `:163` 注释完全一致，不存在漂移 |
| `POST /v1/admin/scheduler/:action` 无 action 白名单 | `admin-jobs.js:22-43` 有 `if (action === 'checkin'/'keepalive'/'probe')` 显式白名单，其余返回 400 |

这三条的保留价值在于：它们记录了"已排除"的边界，后续复审无需重复投入。

---

## 附录 C — 架构正向评价（可作为整改时的参考范本）

以下实现质量高于同类项目平均水平，**整改时应保持这些模式不被破坏**：

1. **密钥分域（K-1）** —— `config.js:157-159` 在启动时强制 `API_KEY !== ADMIN_KEY`，同值即抛错退出。这是把"约定"变成"约束"的典范。

2. **加密密钥失配熔断** —— `lib/startup-checks.js` 通过 `wasKeyGenerated()` + "库里是否有密文"两个条件判定灾难，`fatal:true` 时拒绝启动（`index.js:492-501`）。这防止了"新密钥覆盖 → 所有凭据永久不可解"这一不可逆事故。

3. **错误信息分层** —— `lib/upstream-error.js` 把错误分成"客户端泛化 / 服务端全量"两档，`PUBLIC_CODES` 白名单制，且注释明确区分"网关自产的可行动指引"与"可能含上游报文的错误"。这是本次审计中**最值得推广的模式**。

4. **乐观锁防丢失更新** —— `credentials/store.js:337-378` 只写 patch 出现的列 + `version` CAS + 冲突重读重试，注释完整记录了"旧实现会静默覆盖"的根因。

5. **配置收敛** —— `lib/settings-store.js` 把 5 个设置模块的统一骨架抽出，差异只剩字段表。`config.js` 的 `makeResolveModelOptions` 同理（初始加载与热重载共用实现，避免"返回形态分叉"）。

6. **注释解释"为什么"而非"是什么"** —— 例如 `sse-heartbeat.js` 用 30 行说明"为什么需要心跳"（含实测 p50/p90/p99 数据）、`atomic-write.js` 解释"为什么必须同目录 rename"。这类注释让审计效率提升数倍。

7. **SQL 全参数化 + 列名白名单** —— 仅 2 处动态 SQL，列名均来自静态常量表，值全走 `?`。无注入面。

8. **限流的安全默认值** —— `rate-limit.js:16` 默认 60 RPM 而非 0（不限），注释明确说明"默认不限流"曾导致实际部署中每把密钥都不限流。这是"安全默认"的正确实践。

---
