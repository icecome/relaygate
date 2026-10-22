# WorkBuddy 生态对比报告 — 增补勘误与复核

> **性质**：本文是对同目录 `wb-ecosystem-comparison-2026-10-04.md`（下称"原报告"）的独立复核与勘误，不是替代。复核方式：对原报告全部关键论断逐条与当前工作区代码比对（文件:行号级），并运行三套测试验证代码健康度。
>
> **重要背景**：对比基准目录曾发生混淆。原报告及早期调研一度以 `C:\opt\workstations\project\web\my-trae-api` 为"本项目"，该目录实为**滞后快照**（81 个 src 文件、无 git 历史、136 个单测）；真正的活跃仓库是 **`C:\opt\workstations\project\web\RelayGate`**（93 个 src 文件、18 条提交、单测 158 + 安全 21 + 成长 11 = **190 个测试全部通过**，2026-10-04 实跑验证）。快照缺少 12 个后端模块与若干前端修复，导致部分论断失真。

---

## 一、两空间差异（快照 vs 活跃库）

RelayGate 相比快照新增的后端模块：`lib/mask.js`、`lib/round.js`、`lib/settings-store.js`、`lib/sse-lines.js`、`lib/token-estimate.js`、`routes/admin-debug.js`、`routes/admin-jobs.js`、`routes/admin-notify.js`、`routes/admin-overview.js`、`routes/admin-traffic.js`、`test/security.test.js`、`transform/continue.js`、`transform/finish.js`。

提交历史显示快照分叉后活跃库已完成一轮系统性收口：P0 授权缺口修复（54c94bd）、安全响应头（81aed83）、admin-extras 按领域拆分（9f97abe）、前端可靠性/无障碍收口（ff6c762、c608131）、截断自动续写 AUTO_CONTINUE（38383c1）。

**当前工作区有一批未提交修改**（12 文件 +328/-40，新增 `src/lib/token-estimate.js`），其性质是**独立功能迭代**而非实施原报告的借鉴建议：虚拟模型上下文窗口守门（`model-router/index.js:101` `checkContextLimit`，超声明窗口 75% 显式 400）、WB 模型目录多凭据容错（`workbuddy/chat.js` catalogCredentials 逐账号兜异常）、`workbuddy/auth.js` 对新版客户端 `$wbEncrypted` 加密 token 的归一化防御。这些修改与原报告建议正交，无冲突。

---

## 二、勘误表：原报告已过时的论断

以下论断在**当前 RelayGate 代码中已不成立**（推测原报告基于快照或更早版本写成）：

| # | 原报告论断 | 当前实况（证据） | 影响 |
|---|---|---|---|
| 1 | TL;DR"管理面缺安全响应头"；P0-4 建议加 CSP/nosniff/DENY | **已实现**：`src/index.js` 有 CSP 中间件（`default-src 'self'; script-src 'self'`，style 因 Tailwind 产物放开 unsafe-inline），并区分文档路由与 API 路由（API 不加 CSP 避免干扰客户端）。另有提交 81aed83 佐证 | **P0-4 前半已完成**，从建议清单移除 |
| 2 | §5.3"无 Error Boundary（M-R4）" | **已实现**：`web/src/components/ErrorBoundary.tsx`（getDerivedStateFromError + componentDidCatch），挂在 `main.tsx:10` 根节点 | 从短板清单移除 |
| 3 | §7.2"`/accounts`（无 tab 参数）白屏，建议加 Navigate 兜底" | **已实现**：`web/src/App.tsx:24,26,28` 三处 `<Navigate to=".../all|token|run" replace>`，另有 `*` → `/` 兜底 | 从建议清单移除 |
| 4 | P1-10"修复 Anthropic tools 映射（input_schema 未读）" | **已还债**：`src/upstream/client.js:129` `fn.parameters \|\| fn.input_schema`，且 `unit.test.js:142` 有映射测试 | 从 P1 移除（已完成） |
| 5 | §4.1/§4.3"固定 setInterval，页面不可见时照跑" | **不准确**：全前端仅 `OauthTraeDialog.tsx:70` 一处 setInterval（OAuth 轮询）；管理页（Overview 等）**没有周期自动刷新**，仅操作后 1.2s 延迟拉取（`Overview.tsx:143`）。真实问题相反——是"缺自动刷新"而非"刷新不节流" | P0-3（useHeartbeat）应改写为"按需引入自动刷新 + 可见性感知"，见下文修订 |
| 6 | §2.1"WB 侧只有单一身份，无指纹管理"表述之外，§3.1"设备指纹重置 ✅"与 §2.4 表述并存但未给证据 | **核实为真**：`src/credentials/import.js:273-283` deviceGen+1 重置整套 devices，`lib/auth.js` 按账号 seed 派生 machineId | 维持原报告 ✅ 判定，补充证据 |

另有我早期（基于快照的）调研中两条论断被活跃库推翻，一并更正：

- **"无请求级换号重试"** — 错误。`src/credentials/pool.js:476` `run()` 有完整的 `maxSwitches=3` + `attempted` 集合 + 粘性失败降级 + rate_limit 切换语义，且 `openai.js:334` 的流未开整体轮换与之配套。此项**不需要**借鉴 panel。
- **"测试仅两套"** — 快照实况；活跃库为三套（unit/growth/security），158+21+11=190 用例实跑通过。

---

## 三、复核后仍然成立的短板（按证据强度排序）

这些是本次逐条比对后确认**当前代码确实存在**的差距，构成修订后的建议基础：

1. **429 冷却仍是账号级固定 20s**（`pool.js:441` `coolUntil: now + rateCooldownMs()`；`config.js:136` 注释自证"实测 ~30s 内第 3 个请求即 3004，冷却 ~20s"）。无指数退避、无模型级冷却、无恢复时间解析。原报告 P0-1/P0-2 **完全成立**，这是当前最值得做的借鉴点。
2. **WB 通道出站不走代理**（`workbuddy/chat.js` 与 `auth.js` 全文无 agent/proxy 接入；仅 Trae 通道 `upstream/client.js:74` 有）。原报告 P1-6 成立。
3. **登录密钥明文存 localStorage**（`web/src/stores/useAuth.ts:5,14`）。原报告 M-S3 成立。缓解建议：sessionStorage 或内存 + 刷新重登，成本低于改后端。
4. **亮色 only**（`index.css` `color-scheme: light`，tailwind 无 darkMode 配置）。原报告 P1-11 成立。
5. **WB 出站身份单一**（`workbuddy/auth.js:33` 固定 `WB_IDENTITY.userAgent`，无多身份轮换）。原报告 P1-7 成立。
6. **无前端测试**（web/package.json scripts 无 test；无 vitest 配置）。原报告成立，panel 的 `frontend_test.go` 冒烟思路仍可借鉴（用 Node 对 dist 做存在性冒烟即可）。
7. **管理面无周期自动刷新**（勘误 #5 的另一面）：调度链卡片上的"上次/下次执行"需手动刷新才能更新，对"常驻后台观察者"体验有影响。修订建议：先给 Overview 加 30s 级自动刷新并带 `document.hidden` 跳过（一步到位实现 manager useHeartbeat 的等价物），而非先抽通用 hook。

**原报告结论中被复核确认准确的部分**（无需改动）：Trae 侧逆向深度为独有优势；SSE 三形态工具归一 + 缺参补偿（`transform/sse.js`）；FEFO+costTier 调度（`pool.js:344-355`）；SSRF 白名单（`credentials/oauth.js:34-38`）；四渠道通知 + 去重合并窗口（`notify/index.js:21-23,96-98`）；AES-256-GCM（`lib/crypto.js:7`）；"不建议照搬"四条全部维持。

---

## 四、修订后的优先级建议

在原报告基础上做如下增删，其余条目维持原优先级：

**从 P0 移除**（已完成）：原 #4 安全响应头中间件 + 路由兜底。
**从 P1 移除**（已还债）：原 #10 Anthropic input_schema。

**P0（修订后余 3 项 + 新增 1 项）**：
1. 429 冷却升级：恢复时间解析 + 指数退避（原 #1，不变）
2. 模型级冷却 (账号, 模型) 组合（原 #2，不变）
3. 401 停轮询（原 #5，不变——OAuth 轮询与管理页请求仍会 401 刷屏）
4. **新增：管理面自动刷新 + 可见性感知**（替代原 #3）：Overview 30s 自动刷新 + `document.hidden` 时暂停，切回立即拉取；实现时顺手抽成 hook 即为原 #3 的最终形态。

**P1（余 5 项）**：WB 出站代理槽（#6）、WB 身份轮换（#7）、WAF 文本脱敏（#8）、Responses 事件族补齐（#9）、暗色模式（#11）、TTFT/tok/s 统计（#12）、密钥 IP/有效期/配额（#13，分发场景才做）。

**新增观察项（来自未提交修改，不属于借鉴）**：上下文窗口守门已在工作区实现但未提交，建议尽快提交并为其补 model-router 侧的集成测试（`unit.test.js` 中已有 145 行相关用例，实跑通过）。

---

## 五、截图资产说明

原报告 §8 引用的 13 张截图（`docs/compare/assets/`）**未随仓库提供**，目录不存在；其中 relaygate-0x 系列基于快照 UI，与活跃库现状可能不符，引用时需注意。有效截图：hub 登录页/panel 账号池页（本次复核实截，位于早期调研输出目录）；manager 官方 README 截图（dashboard/keys/stats/playground）。若需将本增补报告连同截图归档，建议将实截图统一放入 `docs/compare/assets/` 并在原报告 §8 表格中标注来源。
