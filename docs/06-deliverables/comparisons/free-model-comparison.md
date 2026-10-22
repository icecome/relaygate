# dsh-our-free-model × RelayGate 功能对比分析

> **本项目基准**：RelayGate v3.1.0（`C:\opt\workstations\project\web\RelayGate`）— Node.js/Express 多平台账号池网关，OpenAI / Anthropic / Codex 三协议出口，Trae / WorkBuddy / ZCode / Qoder 四平台，React 19 + Vite + Tailwind 管理面板。
>
> **对比对象**：[Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) v2.1.0（克隆于 `C:\opt\workstations\project\web\dsh-our-free-model`，与本仓库同级）— DeepSeek Harness 插件 + 独立本地服务（`packages/standalone`），零依赖、无构建步骤的 LLM 模型接入插件，自带本地网关与九页设置面板。
>
> **分析方式**：两仓库均克隆至本地逐文件阅读，引用格式为 `文件:行号`（克隆项目行号以 `../dsh-our-free-model/` 即 `C:\opt\workstations\project\web\dsh-our-free-model\` 为根；本项目行号以仓库根为根）。分析日期：以本文件落盘日为准。
>
> **定位差异（阅读本表前必须知道的一件事）**：dsh-our-free-model 是**模型获取插件**（解决"哪里有免费/便宜的模型可用"），RelayGate 是**账号池网关**（解决"如何把一批账号稳定聚合为可用接口"）。两者共享大量底层能力（本地 OpenAI/Anthropic 网关、账号渠道、用量统计、模型路由），但优化目标不同——前者面向 dsh 宿主内使用，后者面向任意 IDE/脚本客户端。**它的 `packages/standalone` 独立服务形态正在架构上向 RelayGate 收敛**（独立 HTTP 服务 + 网页控制台 + API Key 鉴权 + 账号渠道管理），这使对比更具参考价值。

---

## 一、功能总矩阵

图例：✅ 已有且成熟 / ⚠️ 有雏形或较弱 / ❌ 没有

| # | 功能域 | 能力项 | dsh-our-free-model | RelayGate | 借鉴价值 |
|---|--------|--------|:---:|:---:|:---:|
| 1 | 模型来源 | 免费匿名车道（OpenCode Zen） | ✅ | ❌ | 低¹ |
| 2 | | Kilo 免费池（免密 isFree 清单） | ✅ | ❌ | 低¹ |
| 3 | | EAC 协付渠道（GitHub 授权 + Cloudflare Worker 持密） | ✅ | ❌ | 低¹ |
| 4 | | 13 个白嫖账号渠道（CodeArts/CodeBuddy/WorkBuddy/LobsterAI/Qoder×2/TRAE/Cline/Loomy/Raccoon/MiniMax/ZCode/Gemini） | ✅ | ⚠️ 重叠 4 个² | 中 |
| 5 | | 76 家聚合提供商注册表（自带 Key） | ✅ | ❌ | **高** |
| 6 | 账号池 | 多平台统一账号池 | ⚠️ 渠道内各自为政 | ✅ 四平台统一池 | — |
| 7 | | 选号调度（优先级/FEFO/成本分层/余额/闲置） | ⚠️ 基础 | ✅ 五层比较器 | — |
| 8 | | 模型级冷却 + 指数退避 | ✅ 统一失败分类驱动 | ✅ 健康度冷却 | — |
| 9 | | 粘性会话 | ❌ | ✅ TTL 1h | — |
| 10 | 转发协议 | OpenAI Chat Completions | ✅ | ✅ | — |
| 11 | | Anthropic Messages（原生成帧） | ✅ | ⚠️ 仅 Trae 池、恒流式 | 中 |
| 12 | | OpenAI Responses（Codex） | ✅ | ⚠️ 残血：无工具、fail-closed、仅 3 个 SSE 事件 | 中⁶ |
| 13 | | `/v1/messages/count_tokens` 本地估算 | ✅ | ❌（js-tiktoken 依赖已在，补齐近免费） | 中 |
| 14 | | 工具调用归一化/配对修复 | ✅ 三协议共用 | ✅ **三上游形态归一（独有）** | 互鉴 |
| 15 | | 截断续写 | ✅ 思考检查点恢复（issue #12） | ✅ AUTO_CONTINUE（length 触发，仅 chat/completions） | 互鉴 |
| 16 | | 按响应体形状嗅探 SSE（防 header 欺骗） | ✅ sniffBody | ❌ | **高** |
| 17 | 模型路由 | 虚拟模型/候选池 | ⚠️ combo 虚拟清单行 | ✅ 独立 model-router 模块 | — |
| 18 | | 命名降级链（fallback/round-robin + 粘滞） | ✅ | ⚠️ failover 有，语义较窄 | **高** |
| 19 | | 容量取交集（窗口/视觉/思考） | ✅ | ⚠️ 窗口守门有，仅输入侧 | 中 |
| 20 | | 思考强度档位（硬预算实现） | ✅ 2K/8K/上限 | ❌ | 中³ |
| 21 | 省 Token | 工具输出压缩（RTK，git/grep/ls/tree/构建日志） | ✅ 实测省 90% | ❌ | **高** |
| 22 | | 提示词瘦身（caveman/ponytail） | ✅ 默认关 | ❌ | 低 |
| 23 | | 本地应答（额度探测/命令前缀/标题/建议/文件路径） | ✅ 5 个默认开 | ❌ | 中 |
| 24 | | 节省统计面板 | ✅ | ❌ | 高 |
| 25 | 用量统计 | Token 热力图（17 周） | ✅ | ❌ | **高** |
| 26 | | 总量曲线（总计/单模型切换） | ✅ | ⚠️ 仅每日趋势折线 | 中 |
| 27 | | 输出速度/首字延迟采样 | ✅ windowTokens/decodeWindow | ⚠️ 有首字/耗时记录，无速度视图 | 中 |
| 28 | | 官方账单积分口径 | ❌ | ✅ credit-history + 费率标定 | — |
| 29 | | 请求日志（逐请求明细） | ✅ 运行日志页 | ✅ traffic.jsonl + 请求日志页 | — |
| 30 | 运维体系 | 公告中心（轮询 + HTML 白名单 + urgent 弹窗） | ✅ | ❌ | **高** |
| 31 | | 应用内自更新（签名校验 + 原子替换 + 回滚） | ✅ Ed25519 签名清单 | ❌ | 中⁴ |
| 32 | | 热重载 | ✅ 镜像内核 HMR | ⚠️ `node --watch`（dev） | 低 |
| 33 | | 通知（Webhook/Server酱/Telegram…） | ❌ 仅应用内 toast/SSE | ✅ 四渠道 + 去重 + 合并窗口 | — |
| 34 | | 加密备份/恢复 | ❌ | ✅ AES-256-GCM + 快照 | — |
| 35 | | 审计日志 | ❌ | ✅ append-only | — |
| 36 | | 局域网转发中继（独立中继密钥） | ✅ | ⚠️ HOST=0.0.0.0 裸暴露 | **高** |
| 36b | | 出口代理（单代理 / mihomo 订阅 spawn + 节点健康检查） | ✅ 统一 egressFetch 收口 | ⚠️ 仅 env HTTP(S)_PROXY | 中⁵ |
| 37 | 安全 | 凭据密封（0600 文件 + 指纹回显） | ✅ | ✅ AES-256-GCM 落库 | — |
| 38 | | 访问密钥体系（双密钥分离 + RPM + 资源 ACL） | ⚠️ 单转发 Key + 中继 Key | ✅ sk-admin/sk- 分离 + 模型 ACL | — |
| 39 | | 信任围栏（插件路由优先于内核 /api） | ✅ | ✅ CSP + SSRF 白名单 + OAuth 闸门 | — |
| 40 | UI | 设置面板 | ✅ 九页毛玻璃（手写 ModuleLoader，无构建） | ✅ 八页 React 面板 | 互鉴 |
| 41 | | 客户端接入配方生成（Claude Code/Codex/SDK/curl） | ✅ 按实际端口+Key 生成 | ⚠️ 创建密钥后展示 base URL + curl | **高** |
| 42 | | 首次启动引导 | ✅ 5 页公告 | ⚠️ SetupGate 首登引导 | 低 |
| 43 | | i18n | ✅ en/zh | ❌ | 低 |
| 44 | | 暗色主题 | ❌ | ❌ | — |
| 45 | 工程化 | 离线测试套件 | ✅ 20+ 套件（含变异测试） | ✅ 10 套件 421 断言 | 互鉴 |
| 46 | | 发布清单完整性门禁 | ✅ manifest + 签名 + release-e2e | ❌ | 低⁴ |
| 47 | 账号保活 | 每日签到/token 续期/余额刷新 | ✅ 渠道内建 | ✅ 定时任务体系 | — |
| 48 | | 成长任务/积分领取自动化 | ✅ 渠道页面一键领取 | ✅ growth-auto + qoder/zcode rewards；**渠道页面入口已补齐**（m-40，见 `docs/02-technical/channel-onboarding.md`） | — |

> ¹ RelayGate 的账号渠道本身就是"白嫖"来源，接入免费车道会绕开账号池计费体系，与产品定位冲突——除非未来想拓宽模型来源。
> ² RelayGate 已支持 Trae/WorkBuddy/ZCode/Qoder 四平台，与对方的 13 渠道中 4 个重叠。对方多的 9 个渠道（CodeArts/LobsterAI/Cline/Loomy/Raccoon/MiniMax Code/Gemini/CodeBuddy）是潜在扩展方向。
> ³ RelayGate 上游为真实账号积分，思考预算的经济意义不同；但其"无效控件不如没有"的设计哲学值得吸收。
> ⁴ RelayGate 是自托管单文件部署，`git pull` 即更新，自更新机制的价值远低于插件形态；但其**签名校验 + 原子替换 + 回滚**的链路设计对备份恢复模块有参考价值。
> ⁵ 触发条件：需要为不同账号/平台配置独立出口时才值得；当前 env 级代理对单人场景够用。
> ⁶ RelayGate 的 Responses 面当前仅适合无工具的 Codex 简单对话；补齐工具与事件帧后此行升 ✅。

---

## 二、核心差异详述（含代码证据）

### 2.1 模型路由与降级链 —— 最值得细说的一个维度

两项目都实现了"一个名字背后是多候选"的路由，但语义有实质差异：

**dsh-our-free-model（`src/combos.js`）**
- combo 是**虚拟清单行**（`channel:'combo'` + 真实模型 id 列表，`src/combos.js:33-53`），选择器与本地网关都按名调用，链展开发生在适配器 `runStream()` 内，调用方无感知。
- 两种策略：`fallback`（固定链首）与 `round-robin`（轮换起点 + `stickyLimit` 连续粘滞，`src/combos.js:148-163`）。粘滞设计有明确理由：严格逐轮轮换会击穿每个提供商的 prompt 缓存；严格粘滞则让其余候选形同虚设（`src/combos.js:154-157` 注释）。
- **容量取交集而非并集**：视觉要求全员支持、上下文窗口取最小值、思考可关要求全员可关（`src/combos.js:116-121`）——"一条链不会因为链头能力强就对外声称链尾做不到的事"。
- **降级时机判定（双视图设计）**：链在**输出任何正文增量之前**失败被整段丢弃，切换对调用方不可见；**思考增量刻意不算正文**——"想了很久才撞上配额墙"正是降级最有价值的场景。实现上是两个判定函数：`commitsAnswer()`（text-delta、tool-call-delta、或非 reasoning 的 block-end 有非空白内容 → 提交）与 `sawAnswer`（含 reasoning，用于"绝不换模型"的否决判定）——思考不算提交，但答案一旦交付绝不换模型，否则两段模型的文字会被拼在用户面前（`src/combos.js` 模块头注释 + 适配器 `runCombo`）。

**RelayGate（`src/model-router/index.js`）**
- 虚拟模型（`vm/*`）挂候选列表，候选指向 `provider/model`；分发前做**窗口守门**（输入超窗口 75% 直接 400，`src/model-router/index.js:283-294`）与**候选级窗口过滤**（`autotier.filterCandidatesByInput`，`src/model-router/index.js:324-337`）。
- failover 循环：`maxAttempts` 次尝试 + `tried` 集合 + `switchOn` 错误分类（rate_limit/model/5xx/network/other，`src/model-router/index.js:329-484`）。
- **关键限制**：`canSwitch = ... && !(ctx.stream !== false && res.headersSent)`（`src/model-router/index.js:479-480`），而 `dispatch.js:96-101` 在上游响应头到达时就 `flushHeaders()`——**流一旦建立，即使一个 token 都没吐出（长思考中），也不能再换候选**。这是与 combo 的核心语义差距。

**结论**：RelayGate 的路由模块工程完整性更高（窗口守门、健康度、成本计费、候选管理 UI），但降级语义被"headersSent"卡住了一个本可救回的场景。借鉴 combo 的"内容增量前可降级"判定，是低代价高回报的改进（见 §四 P0-1）。

### 2.2 省 Token —— RelayGate 完全空白、对方最亮的维度

**dsh-our-free-model 的三层管线（`src/token-saver/index.js`）**：
1. **提示词注入**（`inject.js` + `prompts.js`）：caveman（电报体）/ ponytail（YAGNI）两族，按线协议幂等注入（chat 的 system / Anthropic 的 system 块数组插在最后一个 `cache_control` 前 / Responses 的 instructions），可撤销。默认全关——它改变模型的"说话方式"。
2. **工具输出压缩 RTK**（`src/token-saver/rtk/`，14 个过滤器）：git diff/status/log、grep、find、ls、tree、构建与包管理器日志、带行号文件转储、Cursor 搜索清单、重复日志行去重。实测 40KB git diff 移除 90% 字节且模型仍能作答。安全规则：报错的工具结果永不触碰、小于下限不碰、替换结果永不大于原文、过滤器抛错原样放行、整条管线幂等（README「省 Token」节）。
3. **五个本地应答**（`src/local-optimize.js`）：额度探测、shell 命令前缀识别（含命令注入拒绝）、会话标题、建议模式、文件路径提取——请求形状匹配即进程内直接应答，零上游消耗。

**架构关键**：压缩跑在唯一收口 `payloadFor()` 上（适配器派发与本地网关都经此一处），每条车道、每段恢复请求同样被压缩；每一步**失败开放**（fail-open）——"一个请求绝不能因为一个本来是为了让它更便宜的环节而失败"（README「实现结构」节）。

**RelayGate**：无任何请求改写层，转发是纯透传（`src/model-router/dispatch.js:107-117` 旁路窥探 usage 后即原样写出）。对"账号积分=真金白银"的 RelayGate 来说，**上游输入 token 直接烧账号积分，RTK 的节省直接等于省钱**，这是全表中最对口的借鉴项（见 §四 P0-2）。

### 2.3 失败分类学 —— 对方的一等公民，RelayGate 的散落实现

**dsh-our-free-model（`src/route/classify.js`）**：单一失败词汇表，回答两个问题——
- *出了什么事？*（`FAILURE_KIND` 11 类 + `retryable` 标志）供调用方选择重放/轮换/报错；
- *该冷却多久？*（规则表决定 `cooldownMs`，429 指数退避 2s×2ⁿ 封顶 5min，provider 报告的 reset 硬封顶 30min）。
- `scope` 四值（request/account/provider/transient）定位故障归属——**request 类故障冷却健康账号是最被警惕的反模式**（`src/route/classify.js:26-36` 注释）。纯函数：无时钟无 I/O，可完整离线测试。

**RelayGate**：冷却体系本身已相当强——二维冷却（账号×模型的模型级冷却与整号冷却分离，`src/credentials/pool.js`）、rate_limit 指数退避（基数×2^streak 封顶 30min）+ 上游「将在 UTC+8 某时刻重置」文案正则解析精确恢复时刻、quota 硬冷到次日 04:00、5xx 计 5 次熔断（`src/model-router/health.js` + `src/credentials/pool.js`）。但**分类函数散落在 `src/upstream/errors.js`、health.js、pool.js 三处，无统一词汇表**，模型池与虚拟模型各记各的冷却。借鉴价值在于"收敛为单一纯函数模块 + 补 scope 维度"（见 §四 P1-3），而非冷却能力的从零建设。

### 2.4 用量统计与可视化

**dsh-our-free-model**：17 周 Token 热力图（GitHub contribution graph 式，`docs/issue-30-heatmap.md` 记录了 40 项检查与跨年时区夏令时处理）、总量曲线（Token/请求数切换、总计/单模型切换）、速度迷你图。速度口径有精细设计：`windowTokens()` 把未流出的 reasoning token 从分子剔除、`decodeWindow()` 拒绝过短窗口与不真实高速率、看板改 Σtoken/Σ秒 而非各次速率平均（README「为什么速度那一栏会显示 —」节）——曾因 1ms 窗口把均值抬高三个数量级。

**RelayGate**：每日趋势折线（纯 SVG，`web/src/features/stats/DailyTrendChart.tsx`）+ 口径卡片区（官方账单积分/Token/请求三口径分离，`TokenStatsPage.tsx`）+ 按模型/账号两张流量表 + 费率标定（pricing-calib）。**计费口径（官方积分 + 标定费率）远超对方**，但**可视化形态单一**（无热力图、无单模型曲线切换、无速度视图）。TokenStatsPage 有 809 行，信息架构按"口径"分组做得相当成熟。

### 2.5 公告 / 自更新 / 热重载（插件形态特有）

- **公告中心**：仓库 `feed/announcements.json` 推送 → 实例轮询（默认 30min）→ toast / urgent 全屏弹窗 / 系统通知；正文走 HTML 白名单；应用内可"检查新公告"。数据源与更新源解耦，Ed25519 签名防篡改。
- **自更新**：下载 → SHA-256 分级校验 → 备份 → 原子替换 → 校验回读 → 热重载；任一步失败自动回滚。清单 Ed25519 签名（公钥 pin 在插件内），feedUrl 与更新源彻底解耦（v1.3.2 记录）。
- **热重载**：镜像内核 HMR 的缓存清除 + 重导入 + 重注册 + 回滚序列（`src/reload.js`）。

RelayGate 是自托管 Node 服务，无此需求；但"**公告 = 运维者向已部署实例推送结构化消息**"的思路可转化为 RelayGate 的"通知中心"增强（见 §四 P1-4），签名校验 + 原子替换 + 回滚链路对备份恢复模块有设计参考。

### 2.6 局域网中继 —— 安全模型差异显著

**dsh-our-free-model**：渠道网关只监听本机（上游的安全选择）；插件另行提供转发门——调用方用**插件签发与轮换的中继密钥**，转发跳由宿主换用网关凭据（**凭据不出宿主进程**），仅放行 `/v1/*` 模型接口并带环路保护。局域网地址按网卡实时读取（15s 重读），物理网卡地址优先展示。

**RelayGate**：跨机访问 = 改 `HOST=0.0.0.0` + 自配防火墙（`.env.example` 注释明示），HTTP 明文、凭据即访问密钥本体。**对单人自托管这是被文档化的显式取舍**（`docs/01-architecture/known-limitations.md` L39-45），不算缺陷；但若未来要给局域网内其它设备（如另一台开发机、平板上的客户端）供服务，对方的中继密钥模型（独立密钥、可单独轮换、凭据不出进程、仅放行模型接口）是现成参考（见 §四 P1-5）。

### 2.6b 出口代理 —— 第三扇"门"（方向朝外）

**dsh-our-free-model（`src/egress.js`，793 行）**：免费车道/Kilo/出口探测三条出网路径的统一收口 `egressFetch()`，配置出口时把调用改写到自有环回中继。两种形态：
- `client`：已有的 http/https/socks5(h) 代理；
- `subscription`：**spawn mihomo**（Clash Verge core 或本机任意 mihomo 二进制），配 proxy-provider 指向订阅 URL + url-test 组每 5 分钟重测所有节点、429 健康检查即标记节点死亡移出轮换。插件**只拨本地 mixed 端口**、从不自己解析 vless/vmess/trojan URI。
- 安全：中继绑 127.0.0.1 临时端口 + 每次启动随机 key（非开放代理）、mixed 端口带本次启动口令、订阅 URL 作为 bearer 凭据只写 0600 配置文件并只以 hostname 形式回显、`mihomoPath` 来自本地设置且**全程无下载步骤**。

**RelayGate**：仅 env 级 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`（`.env.example:220-222`），全进程全局生效，无法按平台/账号/车道分出口。Trae/WB/ZCode/Qoder 均为国内服务，当前需求弱；但对方"按车道配出口 + 订阅自动选节点"的形态，对未来接入国际上游（如 Qoder 国际版已需要）有参考价值。

### 2.7 流式嗅探、探测判定与健壮性

**dsh-our-free-model**：
- **按 body 形状而非 Content-Type 判定流式**：网关高负载下会以 `200 + application/json` 返回完整 SSE 帧序列。`sniffBody` 只读到首个块就分流（`:` 或 `data|event|id|retry:` → SSE；`{`/`[` → JSON），**已嗅探的字节经 replayStream 回灌**——不用 `response.text()` 缓冲整条流，也不丢一个 token。短回答只要首帧识别为流立即放行（否则会在嗅探窗口等到 deadline 再被 cancel 丢掉整轮、报可重试 TIMEOUT 再花一次额度）。同一纪律被 EAC/Kilo 车道复用。
- **探测判定的"不对称"哲学**：只有网关**点名该模型**（`unavailable` 标记 / 400·404·422 + 特定消息）才把模型移出选择器；**5xx 连消息都不读**（反向代理 503 的标准原因短语就是 "Service Unavailable"，曾因此把可用模型踢出选择器）；401/403/408/425/429/无状态一律保持可达；整轮全被拒时全部保留（选择器永不为空）；整轮全 429 才按 30→120 分钟指数退避。理由写在注释里："选择器里一条过期条目只让用户重试一次，而一次抖动就消失的模型要让用户等一个看不见的 reprobe 周期"。
- 探测只发最小请求（`max_tokens:16`，prompt `ping`），并发=2（低并发是刻意的：车道按 session 计额、429 retry-after 递增）；EAC/Kilo/聚合/链路一律不探（聚合探测=花用户真钱）。
- 流内拒绝识别：200 + SSE 里出现 `{"type":"error"}` 帧 → 记为 unknown 并留原因（否则"每轮都失败的模型"会挂绿标）。
- SSE 注释帧（`:` 开头）填充思考期静默防客户端 idle 超时；流内 error 帧统一走 classifyFailure。

**RelayGate**：SSE 处理在 `src/transform/sse.js`（有状态机，三上游工具形态归一化是其亮点），未见对 content-type 与 body 形状不一致的防御；流中途失败 3.1.0 已修（不再伪装成模型输出，CHANGELOG）。探测侧 RelayGate 有模型自动探活（`MODEL_PROBE_INTERVAL_HOURS`，`.env.example:136-137`），但无"拒因记录 + 自动回归"的闭环。

### 2.8 EAC 渠道（对方独有，架构参考价值高）

Cloudflare Worker 是**唯一持密方**：插件里密封的只是网关地址 + 签名密钥，真实 key 只存 Worker 环境变量；插件被逆向得到的只是一个可随时吊销的间接入口（`worker/README.md`）。签名契约 HMAC-SHA256（时间戳 + 方法 + 路径 + body 摘要），时间戳防重放（±600s），签名密钥可轮换（新旧并存）。GitHub 授权闸门（登录 + star 校验 + 定期复查 + 按账号限流）。SSE 预冲刷（先回 200 + keepalive 注释帧，防 Cloudflare ~100s 源站超时掐流）。

RelayGate 的凭据在自有进程内，无此威胁模型；但"**持密方与使用方分离 + 可吊销间接入口**"的架构思想，对未来"RelayGate 对外提供服务"场景有参考价值。

---

## 三、RelayGate 独有优势（对方没有或不强的）

明确这些是为了**避免在借鉴中自我矮化**——RelayGate 在以下维度是领先者：

| 维度 | RelayGate 现状 | 对方现状 |
|------|---------------|---------|
| 账号池调度工程 | 五层比较器（priority→FEFO 最近权益包到期升序→临期金额→d3/d7→costTier→余额→闲置，Schwartzian 预计算，`src/credentials/pool.js`）、并发上限、FIFO 背压、粘性会话、乐观锁 CAS | 渠道内基础账号池，无统一调度 |
| 跨池权益调度 | **POOL_ACCOUNT_PRIORITY**：模型路由选候选前先比较 Trae 池 vs WB 池的 tier 信号（临期池抢占→余额合计降序→池空沉底），5s 缓存 | 无（渠道各自独立，无跨池概念） |
| 冷却体系 | 二维冷却：(账号,模型) 模型级冷却（6004 类）与整号冷却分离；rate_limit 指数退避（基数×2^streak 封顶 30min）+ 上游「将在 UTC+8 某时刻重置」正则解析精确恢复时刻；quota 硬冷到次日 04:00；5xx 计 5 次熔断 | 规则表驱动冷却（classify.js），无按账号×模型二维冷却 |
| 虚拟模型工程 | autotier 自动分层（vm/unified-chat 116K / large-context 200K / long-context 1M 三层从目录真实窗口生成）；rotateTopN=4 轮转池加权随机（权重按倍率反比 1-8）；pinned 置顶不占轮转名额；重同步保留手工 enabled/pinned | combo 链（见 §2.1） |
| 上下文守门 | 候选级窗口守门：估算输入（含 tools schema）超窗口 75% 返回 400；候选按实测校准窗口>声明窗口>平台地板 100K 过滤路由到大窗口候选；max_tokens 按候选上限钳制 | 容量取交集（声明值），无实测校准 |
| 计量补盲 | 上游缺 usage 时 tiktoken 补算标 tokensEstimated；日志写估算 vs 实际 delta 供校准；WorkBuddy 完全缺 usage → 扫描客户端本地会话日志（增量缓存）作为独立「客户端消耗」口径 | 上游 usage 缺失记 noUsage |
| 调度可解释性 | `/route-check` 逐账号解释不可选原因；虚拟模型逐候选解释（禁用/冷却/平台拒绝+冷却剩余） | 模型卡显示拒因，无候选级解释 |
| 账号保活自动化 | 签到（确定性错峰窗口、busy 码退避、claim 后回读防假成功）→ 成长中心六段编排（幂等 client_token）→ 余额刷新 → 临期告警链；Token 15min 预刷新（per-account OAuth clientId） | 渠道页面手动/半自动 |
| 计费与成本 | 官方账单积分口径 + 费率标定 + 逐请求成本估算（`TokenStatsPage.tsx`） | 仅 token 计数 |
| 通知告警 | 四渠道（Webhook 自定义 method/headers/字段名、Server酱、PushPlus、Telegram）+ 事件级开关 + 1h 去重 + 10min 合并窗口汇总补发 | 无进程外通知 |
| 备份恢复 | AES-256-GCM 全量备份 + 校验和 + 恢复前安全快照（`src/jobs/backup.js`） | 无 |
| 审计 | append-only 审计日志（谁在何时看了密钥明文/导出凭据） | 无 |
| 访问密钥体系 | sk-admin/sk- 双密钥分离 + RPM 滑窗默认 60 + scopes（models:read/invoke、router:read/invoke、admin:*）+ resources（`model:平台/*`、`model:virtual:*` 前缀）+ 平台绑定 + 轮换 24h 宽限期 | 单转发 Key + 中继 Key |
| 生产加固 | 停机钩子链、调度锁、启动健康检查、crash 落盘、OAuth 回调闸门 | 热重载优先 |
| 上游协议资产 | Trae 私有协议转换层（`__dev` 映射、function/scene 语义、SSE 工具块归一化、三形态工具调用：原生分片 tool_calls + `<tool_use>` 文本块花括号平衡扫描 + 裸 JSON、参数残缺从 userText 启发式补偿） | 仅 OpenAI 兼容上游 |
| Qoder 国际版对话面 | 已打通（`POST /v1/qoder/chat/completions`） | Qoder 仅账号渠道 |

---

## 四、可借鉴点与优先级建议

> 优先级标准：**P0** = 直接补短板/省钱，1-2 个迭代内做；**P1** = 明显提升竞争力，规划做；**P2** = 锦上添花/特定条件才做。每项给出落点文件与代价评估。

### P0（高优先）

**1. 降级链"内容增量前可切换"语义（抄 combos）**
- 现状：RelayGate 流式 failover 被 `res.headersSent` 卡死（`src/model-router/index.js:479-480` + `src/model-router/dispatch.js:96-101`），长思考后撞配额墙只能整轮失败。
- 借鉴：combo 的"思考增量不算正文，首个内容 delta 前可无缝换链"判定（README「路由」节 + `src/combos.js` 模块注释）。
- 落点：`src/model-router/dispatch.js` 延迟 `flushHeaders()` 到首个上游内容帧（而非响应头）；`index.js` 的 canSwitch 条件从 `headersSent` 改为"是否已写出非思考内容字节"。思考帧识别可复用 `src/transform/sse.js` 的现有归一化。
- 代价：低-中。两处改动 + 流式测试用例；需仔细处理 SSE 注释 keepalive 帧与思考帧的区分。

**2. RTK 工具输出压缩（抄 token-saver/rtk/）**
- 现状：RelayGate 转发纯透传，上游输入 token 直接烧账号积分；agent 客户端一轮的 git diff 动辄几十 KB。
- 借鉴：14 个过滤器全量移植（`src/token-saver/rtk/`，每个 50-150 行纯函数）；失败开放原则（过滤器抛错原样放行）；幂等保证；替换结果永不大于原文的安全规则。
- 落点：新建 `src/transform/compact.js`（或 `src/token-saver/`），挂在请求归一化之后、dispatch 之前的唯一收口（`src/routes/openai.js` 与 `src/routes/anthropic.js` 的消息构造处）；统计层加"压缩前/后字节、节省比例"列（stats 物化缓存已有管线）。
- 代价：中。过滤器本身可直接改写为 CJS（对方是 ESM）；需要为 Trae 私有协议的消息形态写适配（tool_result 的承载位置与 OpenAI 不同）。
- 注意：RelayGate 的 tool 消息形态经 `src/transform/sse.js` 归一化后已是 OpenAI 标准形态，适配面比预期小。

### P1（中优先）

**3. 统一失败分类学（抄 route/classify.js）**
- 现状：错误分类散落于 `src/upstream/errors.js`、`src/model-router/health.js`、`src/credentials/pool.js` 三处，词汇不统一；冷却能力本身已强（二维冷却、指数退避、精确恢复时刻解析、quota 硬冷、5xx 熔断），缺的是统一词汇与 scope 维度。
- 借鉴：`FAILURE_KIND` 11 类 + `FAILURE_SCOPE` 4 值（request 类故障不冷却账号的原则）+ 规则表驱动冷却。纯函数无时钟，可直接移植为 `src/upstream/classify.js`。
- 落点：替换 `errors.js` 内部实现，保持既有导出签名；health.js 与 pool.js 的冷却调用点改读统一 `cooldownMs`。
- 代价：中。需要回归测试保护现有冷却行为（10 个测试套件中有调度冷却相关断言）。

**4. 公告中心 → RelayGate 通知中心增强**
- 现状：RelayGate 通知是"事件 → Webhook/Telegram"出站单向流，无"运维者向面板推送富文本消息"的入站能力。
- 借鉴：feed 的多源拉取 + HTML 白名单渲染 + 未读计数 + urgent 级别全屏弹窗。RelayGate 不需要轮询远程仓库（单人工具），但"结构化公告 + 已读状态 + 级别分流"可内化为本地机制——例如面板启动时展示"上次备份失败/密钥临期"等聚合事项的持久化消息中心。
- 落点：`src/notify/` 旁新增 `src/announce/`（本地 JSON 存储 + 面板消息中心页）；或更简单：把现有通知事件流在面板内做"未读事件"聚合视图。
- 代价：低-中。视做成本地消息中心还是完整公告系统而定。

**5. 局域网中继密钥模型（抄 chan-relay.js）**
- 现状：`HOST=0.0.0.0` 即暴露全部面，访问密钥 = 凭据本体。
- 借鉴：独立中继密钥（与访问密钥分侧轮换）、仅放行 `/v1/*` 模型接口、凭据不出宿主进程、网卡地址实时读取展示。
- 落点：`src/middleware/auth.js` 加 relay 密钥 kind；新增 `src/routes/relay.js` 薄转发；面板展示局域网地址。
- 代价：中。**前置条件**：确有局域网设备接入需求再做（单人本机场景当前不需要，见 known-limitations 的取舍）。

**6. 客户端接入配方生成器（抄网关页"接入客户端"分区）**
- 现状：RelayGate 创建密钥后展示 base URL + 环境变量 + curl（CHANGELOG 3.1.0），但未按客户端类型生成完整配置（Claude Code 的 settings.json 片段、Codex 的 config.toml、SDK 初始化代码）。
- 借鉴：按实际绑定的端口与真实要求的密钥生成多客户端可复制配方。
- 落点：`web/src/features/accounts/AccessKeysPage.tsx` 创建成功后的就地展示区扩展；`src/routes/admin-overview.js` 的 `/client-config` 端点已有雏形（返回 baseUrl），扩充为分客户端配方。
- 代价：低。纯前端模板拼接。

**7. Token 热力图（抄 issue-30 实现）**
- 现状：每日趋势折线（`DailyTrendChart.tsx`，固定 760px viewBox 单图）。
- 借鉴：17 周列优先周对齐热力图 + 四档色阶 + 悬浮提示 + 零值记录与无记录的区分。对方实现含跨年时区夏令时处理与 40 项测试，SVG 手写无依赖，与 RelayGate 现有图表方案同源。
- 落点：`web/src/features/stats/` 新增 `Heatmap.tsx`；数据走现有 `/v1/admin/stats/daily` 端点扩展 17 周窗口。
- 代价：低-中。前端组件 + 数据端点加窗口参数。

### P2（低优先 / 条件触发）

**8. `/v1/messages/count_tokens` 本地估算**：本地 token 估算（`src/anthropic.js`，插件不含 tokenizer 的近似实现）。RelayGate 已有 `js-tiktoken` 依赖与 `lib/token-precise.js` 补算管线，补齐 count_tokens 端点几乎是免费的。触发条件：有 Claude Code 类客户端直连需求。

**9. SSE 响应体形状嗅探（抄 http.js sniffBody）**：防御"application/json 头 + SSE 体"的网关异常。触发条件：Trae/WorkBuddy 上游实测出现该形态（当前未观测到则不急）。

**10. 五个本地应答（抄 local-optimize.js）**：额度探测/命令前缀/标题/建议/文件路径的进程内直接应答。对 RelayGate 的价值在于省积分，但触发条件较窄（客户端得恰好发这些固定问句）。可只做"额度探测"一项作为连通性自检。

**11. 思考强度档位（抄 effort.js 的预算实现）**："无效控件不如没有"的哲学值得吸收，但 RelayGate 上游是真实积分账号，思考预算的经济学不同。触发条件：未来接入支持思考开关的免费渠道。

**12. 发布清单完整性门禁（抄 catalog/integrity.json + manifest 校验）**：对 git 部署的 RelayGate 价值有限。触发条件：未来做 Release 分发。

### 不建议借鉴

- **13 渠道大杂烩的接入**：对方的渠道体系服务于"免费模型获取"定位，RelayGate 的渠道（Trae/WB/ZCode/Qoder）服务于"账号池稳定聚合"。若未来要拓宽渠道，应单个评估（如 CodeBuddy 与现有 WorkBuddy 同族、Gemini 是高价值目标），而非整体复制。特别地，对方的 OpenCode/Kilo/EAC 三条车道与 RelayGate 的账号计费体系不兼容。
- **应用内自更新 + 热重载全套**：自托管 `git pull` + `npm run build:web` 已覆盖；为省这两步引入签名清单/原子替换/回滚体系不值得。
- **手写 ModuleLoader 前端（client.js 452KB）**：无构建步骤是插件分发约束（目标环境无 devDependencies），RelayGate 的 Vite 构建管线没有理由倒退。但可借鉴其"看板模块挂在独立 fiber，待 webServer 就绪后注册路由"的解耦思路（`index.js` 的 ctx.inject 模式）用于 RelayGate 的懒加载路由。
- **EAC 的 Cloudflare Worker 持密架构**：单人自托管无此威胁模型。若未来对外服务，整套参考 §2.8。
- **caveman/ponytail 提示词瘦身**：改变模型说话方式，对编码助手是负资产；默认全关也说明了对方的克制。

---

## 五、一句话总结

两个项目是**同一问题（让 LLM 可用且便宜）的两个切面**：dsh-our-free-model 把"获取模型"做到了极致（17 条车道 + 免费池 + 聚合注册表），RelayGate 把"经营账号"做到了极致（调度/保活/计费/通知/备份）。RelayGate 值得从对方拿来的，按优先级排是：**降级链的内容增量语义（P0）→ RTK 压缩省钱（P0）→ 失败分类学/热力图/接入配方/公告中心（P1）**；同时不必妄自菲薄——账号池工程、计费口径、通知备份审计这套运维纵深是对方整体没有的。最值得关注的是对方的 `packages/standalone`：它正在把插件能力重组成"独立本地服务 + 网页控制台"，这意味着两个项目的架构终局正在靠近，未来对比应转向该子包。
