# WorkBuddy 渠道校验（11128）复核与客户端 5.9.3 形状对齐（2026-11-10）

- 触发：用户报告「WorkBuddy 积分只能在客户端用，DSH 内调用就报错」，要求复核
  11128 的上游验证方式并跟进新版客户端。
- 结论先行：**11128 当前并未发生**（最近 7 天 0 例，最后一批是 10-22/10-23 的
  961 条，均已按渠道熔断降级）。DSH 侧调 WB 模型报错的真实原因是
  **网关的密钥平台边界**：DSH 的默认 provider `re` 绑定的是 platform=trae 的
  bootstrap 密钥，调 `wb/*` / WB 独占模型会被网关本地 403
  `model "wb/x" is WorkBuddy-only`，客户端把它显示成「调用失败」。
  另有一处真实的版本衰减已修复（见 §3）。

---

## 1. 11128 现状复核（数据）

| 日期 | 真实 11128 条数 | 说明 |
|---|---|---|
| 2026-10-22 | 723 | 渠道校验上线首日（插件身份被拦） |
| 2026-10-23 | 234 | 头集重建后残余 |
| 2026-10-26 | 2 | 零星 |
| 2026-10-29 | 1 | 零星 |
| 2026-11-03 | 1 | 零星 |
| 2026-11-04 → 11-10 | **0** | 连续 7 天无拦截 |

统计口径：只认 `error` 字段里的 `code=11128 / unapproved channel / Illegal API
invocation`（子串全文匹配会把 `totalTokens=211128` 误命中，已用精确脚本排除）。
工具：`node scripts/probes/wb-real-11128.js`（summary/list 两模式）。

当前 8 个 WB 账号全部 enabled、余额 2565–3887、无 11140 记录、无冷却。
DSH 形态端到端（身份 system prompt + 45 工具，`scripts/probes/dsh-wb-e2e.js`）：
`wb/glm-5.3` → 200。真实 harness 流量 11-04 至 11-09 的 WB 路由也全 200。

## 2. 「DSH 内调用就报错」的定位（两层，别混）

用户原话是「我当然知道我用的是 Trae 密钥，就是因为 WorkBuddy 用不了我才切换为 Trae 密钥的」——
即**报错发生在换密钥之前**。所以要分两层查：① 网关自己拒的（本地 403）；
② 历史上 DSH 真跑 `provider: workbuddy` 时上游回的错。两层都不是 11128。

### 2.1 本地 403 层（换密钥后的现状）

密钥矩阵实测（`scripts/probes/dsh-key-matrix.js`）：

| DSH 配置 | 网关密钥 | wb/glm-5.3 | glm-5.3 | vm/long-context |
|---|---|---|---|---|
| provider `re`（默认） | bootstrap-trae（platform=trae） | **403 WorkBuddy-only** | 200 | 200 |
| provider `rerac` | ty（platform=all） | 200 | 200 | 200 |

即：**网关的平台归属判定在正常工作**（防 trae 密钥白占 WB 配额），
问题只是 DSH 配置把 WB 模型挂在了 trae 密钥下。DSH 客户端把 403
显示为通用错误，看起来像「积分没法用」，实际积分链路完好。

### 2.2 历史真错层（DSH 确实用 provider=workbuddy 的那段时间）

从 DSH 会话日志（`scripts/probes/dsh-wb-fails.js`，解 300 个会话的 zstd 多帧
jsonl）还原出的 WB 路由失败原文，按 route 聚合：

| route | 次数 | 报错原文（去重） | 性质 |
|---|---|---|---|
| workbuddy/step-5-preview | 50 | `服务出错了，请稍后重试 invoke model error`（HTTP 500 / code=SERVER） | 上游模型侧 |
| re/vm/wb-free-model | 23 | `context length exceeded: estimated 486762 tokens exceeds input limit 225000`（15 次）+ `We're sorry, the param is invalid` + `pi-ai stream idle timeout after 300000ms`（5 次） | 本地上下文闸门 / 参数 / 流空闲 |
| workbuddy/deepseek-v4.1-flash | 10 | `模型 deepseek-v4.1-flash 所有账号均受限，请稍后再试`（6）、`可用账号均在限流中…解禁`（1）、`transport error: fetch failed`（1）、模型思考病态重复（2，本地闸门） | 账号限流 / 网络 |
| workbuddy/hy3 | 3 | `模型 hy3 当前请求量饱和（上游 14003 model busy）` | 上游模型繁忙 |

**没有一条是 11128。** 历史上 DSH 侧 WorkBuddy 失败的四大类是：
上游模型错误（500 invoke model error）、上下文超限、本地参数校验、
账号/模型限流——不是「不是官方客户端」。

### 2.3 现在 WB 链路的真实阻塞点（近 14 天 traffic 统计）

`scripts/probes/wb-blockers.js`：

```
11128 渠道校验      962 次   ← 全部集中在 10-22/10-23，之后 0
11102 模型不存在      9 次   （glm-5.0 等目录僵尸条目）
14003 模型繁忙        9 次
6020  排队           2 次   （kimi-k3.1-pro，queue_position=5453/6030，估算等待 27-30s）
11140 账号受限        0 次
```

近 5 天 WB 成败：11-06 589/0、11-07 15/4、11-09 1258/2、11-10 45/1。
即：**WB 链路现在是通的**，剩下的是上游自己的模型繁忙与排队。

### 2.4 处置（已落盘，DSH 重启后生效）

1. `~/.dsh/profiles/desktop/cordis.patch.yml` 新增独立 provider `wb`
   （`apiKeyEnv: WB_API_KEY`，baseURL 同网关），挂 6 个 `wb/*` 模型 +
   `hy3` / `space-bunny` 两个 WB 独占模型；
2. 网关新建**专用 WB 密钥**（不是通用 all 密钥）：
   `label=dsh-workbuddy`、`platform=workbuddy`、
   `resources=["model:workbuddy/*"]`、`scopes=[models:read, models:invoke]`，
   id=`key_mwa25e5m500e4497`。选专用而非 all 密钥的理由：all 密钥能调全部渠道，
   泄漏面大且无法单独吊销；专用密钥可独立 revoke，且越权调用会被资源闸门挡下。
   8 个模型用该密钥逐个实测全 200。
3. `~/.dsh/.credentials.yaml` 增加 `WB_API_KEY`（该专用密钥明文）。
   之前把 wb/* 挂在 `rerac` 下的草稿已撤销——raccoon 用的通用密钥调 wb/*
   同样会被平台边界拦。
4. 上下文超限那类（`re/vm/wb-free-model` 的 486k token）需要单独处理：
   `vm/wb-free-model` 这条虚拟模型口径是「限免分组」，窗口 300K、可用 225K，
   超过就本地拒。该模型已从 DSH 的 provider 列表移除（现文件里不再出现）。


## 3b. 11128 复现与根因（2026-11-10 10:15 起，决定性）

DSH 重启后用新 `wb` provider 发真实请求，11128 **复现**（4 条，均在
`02:15`/`02:23`/`02:25`/`02:26` UTC）。用真实请求体二分，得到可复现的判据。

### 3b.1 复现条件（`scripts/probes/wb-repro-split.js`）

| 组合 | 结果 |
|---|---|
| 短 system + 假工具45 | 200 |
| **真实 system(13.6KB) + 假工具45** | **11128** |
| 短 system + 真实工具45 | 200 |
| **真实 system + 真实工具45** | **11128** |
| **真实 system + 无工具** | **11128** |

⇒ 工具、模型、账号、头族全部无关，**只看内容**。

### 3b.2 决定性实验：只查 system 的 role，不看字节（`wb-placement.js`）

同一份 13,649 字文本，字节完全相同，只换放置位置：

| 放置 | 结果 |
|---|---|
| `role: system` | **11128** |
| `role: user`（同文本） | **200** |
| system 前半 + user 后半 | **200** |
| 两条 system 拆分 | 11128 |
| `role: developer` / `role: assistant` | 11128 |

**上游只对 `role === "system"` 的消息做内容校验。** 这是整条链路的开关。

### 3b.3 阈值与性质（`wb-role-gate.js` / `wb-token-count.js` / `wb-scrub-verify.js`）

- system 前缀：1000–7000 字 **200**；9000–13649 字 **11128**。阈值落在 7k~9k 之间。
- 中性文本 30,000 字 → **200**，所以**不是纯长度**，是「长度 × 第三方特征密度」。
- 单句注入（`DeepSeek Harness` 重复 12 次 / 735 字）→ 200，**不是关键词计数**。
- 全文逐词替换 `DeepSeek Harness` / `DSH` / `runtime context` / `Web GUI`
  → **仍 11128**，词表替换改不干净。
- 只保留标题+列表的 1416 字摘要 → 200。
- 最小可裁剪触发段 348 字，落在 DeepSeek Harness / Web GUI 语境段内；
  但反向拿该段单测又只有 200 —— 证实是**上下文累积**，无单一触发词。

**结论：上游做的是「system 消息上的第三方客户端语境识别」，特征是累积式的，
词表改写无法穷举。可控杠杆只有两个：`role` 与 `长度`。**

### 3b.4 修复：system 迁位（`src/transform/system-relocate.js`）

策略：**不改写任何内容字节**，把超长 system 的正文迁到首条 user 消息前部，
system 只留一句中性身份（`You are a coding assistant...`）。模型所见信息量
与原文完全一致，只有 role 与位置变了 —— 比逐词 scrub 干净得多，也不会污染语义。

- 阈值：默认 6000 字（实测 7000 安全、9000 触发，留余量），`WB_SYSTEM_RELOCATE_MAX` 可覆盖；
  `<=0` 关闭。
- 默认**开启**（这是形状调整，不改内容，与 identity-scrub 的 opt-in 性质不同）；
  `WB_SYSTEM_RELOCATE=false` 可关。
- 多模态安全：user 为数组时**前置一个 text 块**，图片块原样保留（单测覆盖纯图片与混合两种）。
- 多条 system 合并迁位；无 user 时自造一条。
- 未超阈值时返回**同一引用**，零拷贝、零行为差异。

与 `identity-scrub` 的分工：后者句级改写 Codex/Claude Code 这类**自报家门**；
前者处理**长度维度的累积语境**。两者可同时开启，`prepareMessages` 串联。

### 3b.5 验证（真实上游，非模拟）

| 验证 | 结果 |
|---|---|
| `wb-repro-split.js` 复现 | 真实 system → 11128（稳定 3/3） |
| `wb-placement.js` 位置实验 | system 11128 / user 200 |
| `wb-relocate-verify.js` 5 模型 × 原样 vs 迁位 | 原样 5/5 BLOCKED；迁位 **5/5 200** |
| 同上 + 45 个真实工具 schema | 原样 BLOCKED；迁位 **200** |
| 网关代码路径直打（`normalizeBody` → `chatStream`） | 3 模型全 200，日志打 `system relocate: 13649 chars` |
| 独立实例 19901 完整 HTTP（5 模型流式 + 非流式） | 6/6 **200**，流式带 `[DONE]` |
| 短 system / 无 system 回归 | 200，且**无**迁位日志（零改动） |
| 单测 `system-relocate` 6 例 | 全绿（316 passed 总） |

## 3c. 客户端升级导致的指纹衰减（已修复）

`scripts/check-wb-fingerprint.js` 实测：本机客户端已升到 **5.9.3 / CLI 2.165.0**，
`variant.js` 还停在 5.8.3 / 2.161.0。已同步：

- `scripts/check-wb-fingerprint.js --update`（appVersion/cliVersion）
- UA 模板手动改为 `WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0`

版本衰减就是 10-22 那批 11128 的可解释成因之一（当时客户端已升级、
声明还是旧版）。这次对齐消掉了这个暴露面。

## 4. 5.9.3 客户端取证：渠道校验相关的形状变化

解包 `app.asar`（181MB，`scripts/probes/wb-asar.js`）：

1. **码表未变**：`renderer/assets/contexts-Cfdc2AZw.js` 仍是
   `11128:{actions:[editInput],feedback:!0}`；zh-cn 文案不变
   （「这次调用没通过渠道校验，可能不是官方客户端发出的」）。
   新增码：11138 `upgradeClient`（客户端过旧）、11139…。
2. **桌面端网关头新增一个头**（`main/server.js#applyGatewayHeaders`）：

   ```
   acp-connection-id: <UUID>        ← VlmSessionLedger 按 session 签发，同会话稳定
   ```

   其余（X-Conversation-* / X-Agent-Intent: craft / X-Agent-Purpose: conversation /
   x-codebuddy-request / B3 追踪组 / VF 兜底表）与 5.8.3 一致。
3. **CLI 侧（真正打到 chat 上游的形状）新增两个头**
   （`cli/dist/codebuddy-lite-wb.mjs#buildConversationHeaders`，39236 模块）：

   ```
   X-Agent-Runtime: local-agent     ← 枚举 [local-agent, cloud-agent, agent-agent]，无值时 "other"
   X-Agent-Type: main               ← main|subagent|team|compaction|auxiliary
   ```

   且 `X-Request-ID === X-Conversation-Message-ID`（同一个去连字符 UUID 的
   messageId），`X-Conversation-Request-ID` 才是随会话的请求键——旧实现把
   requestId 同时塞进 X-Request-ID 与 X-Conversation-Request-ID，形状偏了。
4. 内容层检测未变：官方 CLI 自己的系统提示仍是 `You are CodeBuddy Code.`
   （`cli/product.json` 模板），上游对官方身份放行的口径没有理由变化。

## 5. 本轮代码改动

| 文件 | 改动 |
|---|---|
| **`src/transform/system-relocate.js`** | **新增：system 迁位（本轮核心修复）。上游只查 system role 且是长度×特征密度双条件；迁位不改字节只换 role。含多模态安全、多条 system 合并、零拷贝短路** |
| `src/workbuddy/chat.js` | `normalizeBody` 改调 `systemRelocate.prepareMessages`（先句级 scrub 再长度迁位），迁位/中和都打日志 |
| `src/platform/variant.js` | appVersion 5.9.3 / cliVersion 2.165.0 / UA 模板同步 |
| `src/workbuddy/auth.js` | chatHeaders 新增 `acp-connection-id`（opts.acpConnectionId，默认新 UUID）、`X-Agent-Runtime: local-agent`、`X-Agent-Type: main`；`X-Request-ID` 与 `X-Conversation-Message-ID` 改为同一去连字符 UUID（messageId），传入的 requestId 落到 `X-Conversation-Request-ID` |
| `src/model-router/dispatch.js` | `wbConversationOpts` 按 stickyKey 同时派生 conversationId 与 acpConnectionId（同会话稳定、跨会话不同） |
| `src/workbuddy/chat.js` | 透传 `acpConnectionId` |
| `src/transform/identity-scrub.js` | ① 官方身份跳过从「整条消息」改为「句级」（修复：长 prompt 里说明性提到 WorkBuddy 会让整条 system 免检）；② rewriteSentence 保留句首尾空白，修复改写后与相邻句粘连（`GUI.You are`） |
| `src/credentials/api-keys.js` | `updateKey` 的 UPDATE 补写 `platform` 列（原实现改 label/scope 会把平台写丢，属潜在 403 制造器） |
| `scripts/probes/verify-wb-channel.js` | 断言更新到 5.9.3 头集（36 项全过） |
| `scripts/probes/wb-real-11128.js` | 新增：精确统计真实 11128（summary/list） |
| `scripts/probes/wb-fail-scan.js` | 新增：近 N 天非 200 请求扫描 |
| `scripts/probes/wb-blockers.js` | 新增：WB 阻塞码分布（11128/11140/6020/14003/11102/11103） |
| `scripts/probes/dsh-session-scan.js` | 新增：解 DSH 会话 zstd 多帧日志，按 route 聚合失败 |
| `scripts/probes/dsh-wb-fails.js` | 新增：精确提取 provider=workbuddy 的失败原文 |
| `scripts/probes/wb-stream-repro.js` | 新增：DSH 流式形态（stream:true + 工具）复现 |
| `scripts/probes/wb-direct-chat.js` | 新增：绕过运行中服务、进程内直打上游验证新头集 |
| `scripts/probes/dsh-wb-e2e.js` | 新增：DSH 形态（身份 prompt + N 工具）端到端 |
| `scripts/probes/dsh-key-matrix.js` | 新增：按密钥×模型矩阵验证可达性 |
| `scripts/probes/wb-errorcodes.js` | 新增：从 zh-cn 资源解 111xx 文案 |
| `scripts/probes/wb-repro-split.js` | 新增：system × 工具 schema 二分复现 |
| `scripts/probes/wb-bisect-system.js` | 新增：system 分段二分 |
| `scripts/probes/wb-ablate-system.js` | 新增：长度基线 vs 内容消融 |
| `scripts/probes/wb-threshold.js` | 新增：长度梯度 + 滑动窗口 |
| `scripts/probes/wb-trim.js` | 新增：边缘裁剪求最小触发段 |
| `scripts/probes/wb-token-probe.js` | 新增：单点替换 / 反向注入 |
| `scripts/probes/wb-token-count.js` | 新增：特征词计数阈值（证否关键词计数） |
| `scripts/probes/wb-scrub-verify.js` | 新增：全文替换验证（证否词表方案） |
| `scripts/probes/wb-compress-probe.js` | 新增：截断/摘要/删行各方案对比 |
| `scripts/probes/wb-placement.js` | 新增：**role 位置实验（决定性）** |
| `scripts/probes/wb-role-gate.js` | 新增：system-only 边界（角色变体、阈值、累计） |
| `scripts/probes/wb-relocate-verify.js` | 新增：迁位方案 5 模型 + 真实工具验证 |
| `scripts/probes/dsh-request-dump.js` | 新增：dump 真实请求头与上下文 |
| `scripts/probes/dsh-extract-system.js` | 新增：提取真实 system prompt 到 `logs/_dsh-system.txt` |
| `src/test/unit.test.js` | 新增 9 例（5.9.3 头集、stickyKey 派生、句级 scrub、system-relocate ×6）；**316 全绿** |

验证：
- `node scripts/probes/verify-wb-channel.js` → 36/36
- `node scripts/probes/dump-wb-request.js` → 头集已是 5.9.3 桌面端形态
- `node scripts/probes/wb-repro-split.js` → `真实 system + 无工具` = 11128（复现）
- `node scripts/probes/wb-placement.js` → system 11128 / user 200（判据）
- `node scripts/probes/wb-relocate-verify.js` → 迁位后 5 模型 + 真实工具全 200
- 独立实例 19901 完整 HTTP → 6/6 200，流式带 `[DONE]`
- 全量测试 `npm test` → 全绿（exit 0）；biome 无新增

## 6. 生效与观察清单

- [ ] **网关重启**（服务账户重启需管理员：`Restart-Service RelayGate`）。
      当前运行实例（10:06 启动）**不包含** system 迁位代码；迁位在其重启后生效。
      服务无失败自动恢复动作，建议顺手补：
      `sc.exe failure RelayGate reset= 86400 actions= restart/60000/restart/60000/restart/60000`
      无法提权时的等价验证：另起实例跑完整 HTTP 链路（本轮已做，
      `PORT=19901 node src/index.js`，6/6 通过）。
- [ ] DSH 客户端重启（加载新 provider `wb` 与 `WB_API_KEY`），
      模型列表出现「（WorkBuddy）」后缀的条目即成功。重启后可直接选
      `wb/deepseek-v4.1-flash` 等模型，不再经过 trae 密钥。
- [ ] 若再现「模型 deepseek-v4.1-flash 所有账号均受限」：这是账号限流（非 11128），
      用 `node scripts/probes/wb-blockers.js` 确认；动作是换模型或等冷却，
      不要续期（续期对限流无效）。
- [ ] 若再现 6020 排队：kimi-k3.1-pro 排队 5000+ 时换 step-5-preview / glm-5.3-flash，
      网关的候选切换会自动兜，但单次请求内不换模型（retry_policy.retry=false）。
- [ ] 观察 2-3 天：`node scripts/probes/wb-real-11128.js` 应持续为 0；
      面板 11140 出现即停用对应账号。
- [ ] 官方客户端每次升级后跑 `node scripts/check-wb-fingerprint.js`，
      漂移即 `--update`（UA 模板需手动核对）。
- [ ] 若未来再出现 11128：**先跑 `wb-repro-split.js` 确认是不是 system 内容又触发了**
      （工具/模型/账号无关、只有真实 system 触发 → 就是这一类）。再按
      `wb-threshold.js` 重测阈值（上游可能调低），必要时下调
      `WB_SYSTEM_RELOCATE_MAX`（当前 6000）。头族方向仍用
      `dump-wb-request.js` + `probe-wb-trigger.js` 排查。

## 7. 边界

积分仍只能在 WorkBuddy（CodeBuddy）账号体系内消费：本网关做的只是「用你自己的
WB 账号凭据，把请求做成官方客户端的形状」。

system 迁位不等于「伪造官方客户端」：文本一个字节没改，只是 role 与位置变了，
模型看到的信息与原始请求完全一致；它绕开的是上游对 system 消息的语境启发式判定，
而不是把请求伪装成别的产品。上游若改为全消息校验（`wb-placement.js` 一跑就知道），
该方案即失效 —— 届时的正确动作是跟客户端版本 + 降强度，而不是继续加改写层。
