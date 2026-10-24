# WorkBuddy 上游风控收紧：情报汇总与应对（2026-10-22）

## 1. 上游收紧时间线（公开情报核实）

| 日期 | 事件 | 信源 |
|---|---|---|
| 2026-10-15 | 国际版开始强制 `X-Conversation-*` 头族，缺失即 11128 "conversation id missing" | github.com/decolua/9router#5005、Ebony-Vinyl/dsh-our-free-model#369 |
| 2026-10-16 | linux.do 出现「workbuddy 开始挡非官客户端了吗」 | linux.do/t/topic/3031277 |
| 2026-10-19 | workbuddy-manager 国际版账号全面 11128 | github.com/ithtelab/workbuddy-manager#229 |
| 2026-10-20 | DSH WorkBuddy Connect 停维（10-22 下线）；社区出现实际封号 + 积分清零案例 | blog.liurb.org/posts/2026/10/20/workbuddy-connect/ |
| 2026-10-20 | **内容层检测实锤**：请求头全对，system prompt 带 Codex/Claude Code 身份声明仍被 11128 拒；Hermes/OpenCode/Pi 放行 | linux.do/t/topic/3051650 |
| 2026-10-21 | 「再次收紧」；**检测按账号灰度**——部分账号被提升检测等级 | linux.do/t/topic/3039230/13 |
| 并行 | workbuddy2api-panel 停维（第一条理由：上游开始禁用反代）；dsh-our-free-model 收律师函，提及第三方用户 IP 被封 | workbuddy2api-panel README、dsh-our-free-model#576 |

错误码阶梯（社区观测归纳）：`11128` 请求形状拦截（HTTP 400）→ `11140` 账号受限（HTTP 403）→ 积分清零/封号 →（极端个案）IP 封禁。

## 2. 模拟程度评估（以 asar 取证为基准）

| 检测面 | 状态 | 说明 |
|---|---|---|
| UA 桌面身份（`WorkBuddy/5.8.3 … CLI/2.161.0`） | ✅ | 本机 asar 实测一致（`scripts/check-wb-fingerprint.js` 可随时复核） |
| `X-IDE-Type/Name/Version` | ✅ | |
| `X-Conversation-*` 头族 | ✅ | conversationId 按 stickyKey 哈希，会话内稳定 |
| `X-Agent-Intent/Purpose`、`X-Private-Data`、`x-codebuddy-request` | ✅ | |
| traceparent/B3 | ✅ | |
| 不带插件身份（`X-Client-Platform: web`、Origin/Referer） | ✅ | |
| **请求体形状**（body 侧会话元数据） | ⚠️ 未模拟 | 无证据上游查这层，属未知面 |
| **内容层指纹**（system prompt 身份声明） | ✅ 可选应对 | `WB_IDENTITY_SCRUB=true` 启用中和（见 §4）；默认关闭 |
| **行为层指纹**（IP/并发/TLS/JA3） | ❌ 未处理 | 无证据上游已用；属风控厂商标准下一步 |

总评：请求头面 ~90% 复刻（高置信，asar 为准）；11128「形状关」过得去；内容关有 opt-in 应对；行为关完全暴露（单号个人用量下风险低）。

## 3. 被检测几率与封号风险（定性）

- 头族校验档（灰度默认）：单号、个人强度使用，短期内被 11128 拦的概率低。存在**版本衰减**——官方客户端升级后静态指纹变旧（社区有 5.5.2 旧版本被怀疑的先例），用 `scripts/check-wb-fingerprint.js` 跟进。
- 内容校验：取决于调用方。harness 的 system prompt 带第三方身份声明即命中；`WB_IDENTITY_SCRUB=true` 可中和。
- 行为/聚合：与用量成正比。被封案例集中在批量注册、多号池轮转、额度转售；单号个人用量属低风险画像。
- 封号信号：11140 出现即账号级处置前兆，伴随积分清零则大概率已被处置。

## 4. 本项目已落地的应对（本轮变更）

1. **11140 账号受限分类**（`src/upstream/errors.js`、`src/model-router/health.js`、`index.js`、`src/platform/variant.js`）
   - 新错误类 `'account'`：先于泛化 403/auth 判定，**不触发续期**（受限账号续期无效）。
   - 冷却 2h（`ACCOUNT_RESTRICT_COOLDOWN_MS`）：受限不是几分钟内恢复的状态，短冷却会反复撞墙加重画像；2h 后放探测请求，成功即由 markOk 清零。
   - 本次请求内跳过受限候选（`restrictedCandidates`），同平台其他账号不受影响；`shouldSwitch('account')` 放行 failover。
   - 全灭出口给可执行提示：换账号/等冷却，续期与重试无效。
   - 健康快照新增 `lastChannelBlockAt` / `lastAccountRestrictedAt` 观测字段。
2. **内容层身份声明中和（opt-in）**（`src/transform/identity-scrub.js`，接入 `src/workbuddy/chat.js#normalizeBody`）
   - `WB_IDENTITY_SCRUB=true` 启用；默认**关闭**（默认改模型所见内容不可接受）。
   - 只动 system 消息、只动命中身份声明指纹的句子，改写为等义的「coding assistant」；官方客户端身份（WorkBuddy/CodeBuddy/Hermes/OpenCode/Pi）整条跳过；user 消息一律不动。
   - **只认自述句式**（`You are X` / `I am X` / `你是 X`）：2026-10-24 修正——裸 token 匹配会把环境描述误判成身份声明（实测对 ARMOR 提示词误伤 2 句），现在句中提及不再命中；对真实提示词复验零改写。E2E 验收：`You are Claude Code…` 经 scrub 后上游 200 放行。
   - 局限：只处理已知指纹句式；上游可随时换检测词——这是折衷而非完备解。
3. **指纹版本跟进**（`scripts/check-wb-fingerprint.js`）
   - 安装路径自动探测（`scripts/lib/wb-install.js`）：`WB_ASAR` 环境变量 → 注册表卸载条目的 `DisplayIcon`/`UninstallString`（自定义安装位置也能定位）→ 常见安装路径（`%LOCALAPPDATA%\Programs`、`%ProgramFiles%`）→ 开发机历史路径兜底；无硬编码开发机路径。
   - 读本机真实 asar（app 版本 = 根 package.json；CLI 版本 = `cli/package.json` 的 `publishConfig.customPackage.version`，与官方 `codebuddy` 启动器取值链一致）对比 variant.js 声明。
   - 漂移时退出码 1（供 cron/CI 报警）；`--update` 自动改 variant.js（只动 `[WORKBUDDY]` 块）。
   - 注意：UA 模板 `identity.userAgent` 内嵌版本号需手动同步核对（或 `WB_UA` 临时覆盖）。
4. 测试：unit 套件新增 3 例（11140 分类、identity-scrub 行为矩阵、wb-install 路径探测），303 全绿；全套件 exit 0；biome 相对 HEAD 零新增诊断。

## 5. 运维清单

- [ ] 管理员 `Restart-Service RelayGate`（当前运行实例仍是 11128 敏感的插件身份代码，重启是第一优先级）。
- [ ] 重启后 2-3 天压低用量观察 11128/11140 计数，无异常恢复正常强度（金丝雀）。
- [ ] 如需内容层应对，`.env` 加 `WB_IDENTITY_SCRUB=true`（有改写正确性代价，默认不开）。
- [ ] 官方客户端每次升级后跑 `node scripts/check-wb-fingerprint.js`，漂移即 `--update` + 重启。
- [ ] 面板关注 11140；出现即停用该账号，勿反复重试。
- [ ] 写代码场景可切 CodeBuddy 链路（同账号积分通用），WorkBuddy 侧保持低强度办公任务。

## 6. 未验证项

- 11128/11140 灰度门无法主动复现：分类与冷却逻辑只经单测验证，未经真实上游端到端验证。
- identity-scrub 对真实 harness prompt 的改写效果未在真实流量上观测（建议启用后先在测试会话观察）。
- 行为层（IP/TLS）指纹纯理论暴露，上游是否使用无情报。
