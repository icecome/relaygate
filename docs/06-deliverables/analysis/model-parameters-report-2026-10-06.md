# RelayGate 已授权账号 AI 模型参数探测报告

> **探测时间**：2026-10-06 13:20–13:35（UTC+8，实时探测）
> **探测范围**：RelayGate 网关当前已授权访问的全部 16 个账号（Trae 平台 8 个 + WorkBuddy 平台 8 个）
> **探测方式**：复用网关自身上游通道（与业务请求同源凭据），逐平台拉取实时模型目录
> **报告生成**：2026-10-06

---

## 1. 探测方法与数据来源

| 优先级 | 来源 | 说明 | 本次状态 |
|---|---|---|---|
| L1 | **实时上游探测** | Trae：`POST /api/ide/v1/get_detail_param`（与 Trae 客户端同源）；WorkBuddy：`GET /console/enterprises/personal/models` | ✅ 两平台均成功（2026-10-06） |
| L2 | 历史探测快照 | `logs/get_detail_param.json`（2026-09-11 存档）、`output/.trae-api/model-status.json`（探活结果，2026-09-11 ~ 09-22） | ✅ 用于交叉验证与可用性佐证 |
| L3 | 本地静态配置 | `model-config.json`、`model-fallback.json`、`model-router.json`（虚拟模型声明） | ✅ 仅上游不可达时兜底 |

**参数口径说明**（重要）：

- **Trae 平台的 `context_window_tokens`（上下文窗口）与 `prompt_max_tokens`（输入上限）不是同一个值**。实测规律：`prompt_max_tokens ≈ context_window_tokens − 16000`（上游为输出/推理预留约 16K–64K）。本报告以 **`context_window_tokens` 为上下文窗口**、`prompt_max_tokens` 为输入保护上限、`max_tokens` 为**最大输出 token 数**。
- Trae 多数模型返回 **`__dev`（标准档）与 `__max`（长上下文档）两套参数**，网关按请求自动选择档位；两档分别列出。
- WorkBuddy 目录直接返回 `maxInputTokens` / `maxOutputTokens`，其中 `maxInputTokens` 即该模型实际可用的输入+输出总窗口。
- **生效日期**：本次为实时探测，参数自 2026-10-06 起生效；上游参数由平台侧动态下发，后续以最近一次探测为准（网关内置目录缓存 TTL 10 分钟，自动探活每 6 小时一轮）。

---

## 2. 已授权账号清单（16 个，全部 enabled，凭据均在有效期内）

### 2.1 Trae 平台账号池（8 个，CN 版，上游 https://api.trae.cn）

| 账号 ID（脱敏） | 账号标签 | 状态 | 积分余额 | 凭据有效期至 |
|---|---|---|---|---|
| acct_muts0ey… | 15833374517 | enabled | 4,738.38 | 2026-10-18 |
| acct_mutrttx… | 17395025927 | enabled | 4,787.80 | 2026-10-18 |
| acct_mtyjv4x… | 18032213389 | enabled | 380.46 | 2026-10-09 |
| acct_mutsxvg… | 18103270786 | enabled | 4,788.00 | 2026-10-18 |
| acct_mutt0mt… | 18232808772 | enabled | 4,786.76 | 2026-10-18 |
| acct_mtyjtmw… | 18630893389 | enabled | 200.00 | 2026-10-09 |
| acct_mutrxmg… | 18932771517 | enabled | 4,703.05 | 2026-10-18 |
| acct_mtyjr9u… | 19075795328 | enabled | 315.40 | 2026-10-09 |

### 2.2 WorkBuddy 平台账号池（8 个，腾讯 CodeBuddy 系，上游 https://copilot.tencent.com）

| 账号 ID（脱敏） | 账号标签 | 状态 | 积分余额 | 凭据有效期至 |
|---|---|---|---|---|
| acct_mutsklr… | 15833374517 | enabled | 2,707 | 2026-11-11 |
| acct_muts4w9… | 17395025927 | enabled | 2,617 | 2026-11-11 |
| acct_mtzhykj… | 18032213389 | enabled | 3,340 | 2026-10-16 |
| acct_mutt4b9… | 18103270786 | enabled | 2,705 | 2026-11-11 |
| acct_mutsrk4… | 18232808772 | enabled | 2,707 | 2026-11-11 |
| acct_mtylozz… | 18630893389 | enabled | 3,538 | 2026-11-12 |
| acct_mutsiri… | 18932771517 | enabled | 2,697 | 2026-11-11 |
| acct_mtzi03g… | 19075795328 | enabled | 4,022 | 2026-11-12 |

> **模型可见性规则**：两平台均为**账号池级统一目录** —— 同平台所有已授权账号可见并可用完全相同的模型集合（平台侧下发，未观察到账号级模型 ACL 差异）。因此下文模型按「平台 → 模型」组织，适用于该平台全部 8 个账号。

---

## 3. Trae 平台模型参数总表（适用全部 8 个 Trae 账号）

数据来源：`get_detail_param` 实时探测（2026-10-06）；积分为平台计费倍率（credits/token 倍率，越低越省）。

### 3.1 对外可见的官方模型（19 个）

| 模型 ID | 显示名 | 档位 | 上下文窗口 (tokens) | 输入上限 (tokens) | **最大输出 (tokens)** | 单轮对话上限 | 能力 | 积分倍率 |
|---|---|---|---:|---:|---:|---:|---|---:|
| Doubao-Seed-Evolving | Seed-Evolving | dev | 256,000 | 224,000 | **32,000** | 70 | 多模态·工具调用 | 0.08 |
| Doubao-Seed-Evolving | Seed-Evolving | max | 1,000,000 | 936,000 | **64,000** | 70 | 多模态·工具调用 | 0.08 |
| Doubao-Seed-2.1-Pro | Seed-2.1-Pro-0915 | dev | 256,000 | 224,000 | **32,000** | 70 | 多模态·工具调用 | 0.08 |
| Doubao-Seed-2.1-Pro | Seed-2.1-Pro-0915 | max | 1,000,000 | 936,000 | **64,000** | 70 | 多模态·工具调用 | 0.08 |
| Doubao-Seed-2.1-Turbo | Seed-2.1-Turbo | dev | 256,000 | 224,000 | **32,000** | 70 | 多模态·工具调用 | 0.20 |
| Doubao-Seed-Code | Seed-Code | dev | 256,000 | 224,000 | **32,000** | 70 | 多模态·工具调用 | 0.06 |
| glm-5.3 | GLM-5.3 | dev | 116,000 | 100,000 | **16,000** | 70 | 推理·工具调用 | 0.78 |
| glm-5.3 | GLM-5.3 | max | 1,000,000 | 936,000 | **64,000** | 70 | 推理·工具调用 | 0.78 |
| glm-5.3-flash | GLM-5.3-Flash | dev | 116,000 | 100,000 | **16,000** | 70 | 推理·多模态 | 0.06 |
| glm-5.3-flash | GLM-5.3-Flash | max | 1,000,000 | 936,000 | **64,000** | 70 | 推理·多模态 | 0.06 |
| glm-5.3-flashx | GLM-5.3-FlashX | dev | 116,000 | 100,000 | **16,000** | 70 | 推理·多模态 | 0.31 |
| glm-5.3-flashx | GLM-5.3-FlashX | max | 1,000,000 | 936,000 | **64,000** | 70 | 推理·多模态 | 0.31 |
| glm-5.2 | GLM-5.2 | dev | 116,000 | 100,000 | **16,000** | 70 | 推理·工具调用 | 0.78 |
| glm-5.2 | GLM-5.2 | max | 1,000,000 | 936,000 | **64,000** | 70 | 推理·工具调用 | 0.78 |
| deepseek-v4.1-flash | DeepSeek-V4-Flash 正式版 | dev | 116,000 | 100,000 | **16,000** | 70 | 推理·多模态 | 0.15 |
| deepseek-v4.1-flash | DeepSeek-V4-Flash 正式版 | max | 1,000,000 | 936,000 | **64,000** | 70 | 推理·多模态 | 0.15 |
| DeepSeek-V4-Flash-Official | DeepSeek-V4-Flash 正式版 | dev | 116,000 | 100,000 | **16,000** | 70 | 推理 | 0.20 |
| DeepSeek-V4-Flash-Official | DeepSeek-V4-Flash 正式版 | max | 1,000,000 | 936,000 | **64,000** | 70 | 推理 | 0.20 |
| DeepSeek-V4-Pro-Official | DeepSeek-V4-Pro 正式版 | dev | 116,000 | 100,000 | **16,000** | 70 | 推理 | 0.72 |
| DeepSeek-V4-Pro-Official | DeepSeek-V4-Pro 正式版 | max | 1,000,000 | 936,000 | **64,000** | 70 | 推理 | 0.72 |
| kimi-k3 | Kimi-K3 | dev | 200,000 | 168,000 | **32,000** | 200 | 多模态·工具调用 | 1.83 |
| kimi-k3 | Kimi-K3 | max | 1,000,000 | 936,000 | **64,000** | 200 | 多模态·工具调用 | 1.83 |
| kimi-k2.8-preview | Kimi-K2.8-Preview | dev | 200,000 | 168,000 | **32,000** | 200 | 推理·多模态 | 0.98 |
| kimi-k2.8-preview | Kimi-K2.8-Preview | max | 1,000,000 | 936,000 | **64,000** | 200 | 推理·多模态 | 0.98 |
| minimax-m3 | MiniMax-M3 | dev | 116,000 | 100,000 | **16,000** | 70 | 推理·多模态 | 0.26 |
| minimax-m3 | MiniMax-M3 | max | 1,000,000 | 936,000 | **64,000** | 70 | 推理·多模态 | 0.26 |
| qwen3.8-flash | Qwen3.8-Flash | dev | 200,000 | 168,000 | **32,000** | 200 | 推理·多模态 | 0.08 |
| qwen3.8-flash | Qwen3.8-Flash | max | 1,000,000 | 936,000 | **64,000** | 200 | 推理·多模态 | 0.08 |
| qwen3.8-max | Qwen3.8-Max | dev | 200,000 | 168,000 | **32,000** | 200 | 推理·多模态 | 1.50 |
| qwen3.8-max | Qwen3.8-Max | max | 1,000,000 | 936,000 | **64,000** | 200 | 推理·多模态 | 1.50 |
| qwen-3.7-plus | Qwen3.7-Plus | dev | 200,000 | 168,000 | **32,000** | 200 | 推理·多模态 | 0.25 |
| qwen-3.7-plus | Qwen3.7-Plus | max | 1,000,000 | 936,000 | **64,000** | 200 | 推理·多模态 | 0.25 |
| step-5-preview | Step-5-Preview | dev | 116,000 | 100,000 | **16,000** | 70 | 推理·多模态 | 0.48 |
| step-5-preview | Step-5-Preview | max | 1,000,000 | 936,000 | **64,000** | 70 | 推理·多模态 | 0.48 |

### 3.2 平台保留（invisible）模型 —— 目录下发但不对终端用户展示

以下模型在目录中标记 `is_invisible_to_user=true`，经由网关仍可显式调用（参数全部实测自同一探测响应）：

| 模型 ID | 上下文窗口 | 输入上限 | **最大输出** | 备注 |
|---|---:|---:|---:|---|
| glm-5.1 / glm-5 / glm-4.7 / glm-4.6 | 116,000 | 100,000 | **16,000** | 旧版 GLM 系列，已由 5.2/5.3 接替 |
| DeepSeek-V4-Flash / DeepSeek-V4-Pro（非 Official） | 116,000 | 100,000 | **16,000** | 与 Official 版参数一致，Official 为推荐入口 |
| kimi-k2（Kimi-K2-0905）/ kimi-k2.7-code | 116,000 / 200,000 | 100,000 / 168,000 | **16,000 / 32,000** | 旧版 Kimi |
| qwen-3.5（Qwen3.5-Plus）/ qwen3-coder（Qwen3-Coder-Next） | 116,000 | 100,000 | **16,000** | 旧版 Qwen |
| minimax-m2 / minimax-m2.1 | 116,000 | 100,000 | **16,000** | 旧版 MiniMax |
| Doubao_1_6（内部 Seed-Code 旧入口） | 116,000 | 100,000 | **16,000** | 默认配置项，已由 Doubao-Seed-Code 接替 |
| doubao-for-auto / glm-4.7-auto / glm-5.1_advisor / glm-5.2_advisor_doubao | 116,000 | 100,000 | **16,000** | auto 路由 / advisor 内部模型 |
| summary（内部工具） | 256,000 | 224,000 | **32,000** | 会话摘要专用 |
| fast_apply / fast_apply_new（内部工具） | 40,000 | 20,000 | **20,000** | 代码快速应用 |
| title_generation / input_optimization（内部工具） | 44,096 | 40,000 | **4,096** | 标题生成/输入优化，单轮 |

### 3.3 账号内自定义模型（config_source=3，用户/租户自建接入）

| 模型 ID | 输入上限 | **最大输出** | 单轮上限 | 状态 |
|---|---:|---:|---:|---|
| agnes-2.5-flash | 184,000 | **16,000** | 200 | 可用（探活 usable，2026-09-11） |
| agnes-2.0-flash | 512,000 | **65,000** | 200 | 目录存在，探活曾报不可用 |
| deepseek-v4-flash（自定义接入） | 184,000 | **16,000** | 200 | 配置关闭（switch=false） |

### 3.4 网关虚拟模型（model-router 声明，跨账号聚合路由）

| 虚拟模型 | 声明上下文窗口 | **最大输出** | 候选链（按优先级） | 生效来源 |
|---|---:|---:|---|---|
| vm/unified-chat | **168,000**（取候选真实窗口最小值） | **131,072**（目录下发值） | workbuddy:wb/deepseek-v4.1-flash → wb/glm-5.3-flash → trae:DeepSeek-V4-Flash-Official → trae:glm-5.3-flash → …（共 10+ 候选） | `model-router.json` + 上游目录 |
| — 守门机制 | 输入超窗口 75% 时返回 400 `context_length_exceeded` | 截断自动续写：`AUTO_CONTINUE`，最多 `MAX_CONTINUES=5` 轮 | — | `.env.example` 规范 |

---

## 4. WorkBuddy 平台模型参数总表（适用全部 8 个 WorkBuddy 账号）

数据来源：`/console/enterprises/personal/models` 实时探测（2026-10-06）。`maxInputTokens` 为该模型输入+输出总窗口，`maxOutputTokens` 为**最大输出 token 数**。

| 模型 ID | 显示名 | **上下文窗口 (tokens)** | **最大输出 (tokens)** | 能力 | 积分倍率 |
|---|---|---:|---:|---|---:|
| glm-5.3 | GLM-5.3 | **1,000,000** | **64,000** | 推理·工具调用 | 0.79 |
| glm-5.3-flash | GLM-5.3-Flash | **1,000,000** | **131,072** | 推理·工具调用 | 0.06 |
| glm-5.2 | GLM-5.2 | **1,000,000** | **64,000** | 推理·工具调用 | 0.79 |
| glm-5.1 | GLM-5.1 | 200,000 | **48,000** | 推理·工具调用 | 0.79 |
| glm-5.0 | GLM-5.0 | 200,000 | **48,000** | 推理·工具调用 | 0.80 |
| glm-5v-turbo | GLM-5v-Turbo | 200,000 | **64,000** | 推理·多模态 | 0.71 |
| glm-4.7 | GLM-4.7 | 200,000 | **48,000** | 推理·工具调用 | 0.23 |
| glm-4.6 | GLM-4.6 | 168,000 | **32,000** | 推理·工具调用 | 0.23 |
| glm-4.6v | GLM-4.6V | 128,000 | **32,000** | 推理·多模态 | 0.11 |
| deepseek-v4.1-flash | Deepseek-V4.1-Flash | **1,000,000** | **128,000** | 推理·工具调用 | 0.11 |
| deepseek-v4-flash | Deepseek-V4-Flash | **1,000,000** | **50,000** | 推理·工具调用 | 0.17 |
| deepseek-v4-pro | Deepseek-V4-Pro | **1,000,000** | **128,000** | 推理·工具调用 | 0.51 |
| deepseek-v3-2-volc | DeepSeek-V3.2 | 96,000 | **32,000** | 推理·工具调用 | 0.29 |
| kimi-k3-1 | Kimi-K3 | **1,000,000** | **32,000** | 推理·工具调用 | 1.62 |
| kimi-k2.8-preview | Kimi-K2.8-Preview | **1,000,000** | **64,000** | 推理·工具调用 | 0.77 |
| kimi-k2.7 | Kimi-K2.7-Code | 256,000 | **32,000** | 推理·工具调用 | 0.57 |
| kimi-k2.6 | Kimi-K2.6 | 256,000 | **32,000** | 推理·工具调用 | 0.52 |
| kimi-k2.5 | Kimi-K2.5 | 164,000 | **32,000** | 推理·工具调用 | 0.45 |
| kimi-k2-thinking | Kimi-K2-Thinking | 164,000 | **32,000** | 推理·工具调用 | 0.54 |
| minimax-m3 | MiniMax-M3 | **512,000** | **64,000** | 推理·工具调用 | 0.25 |
| minimax-m2.5 | MiniMax-M2.5 | 200,000 | **48,000** | 推理·工具调用 | 0.18 |
| hy3 | Hy3 | 192,000 | **64,000** | 推理·工具调用 | 0（免费） |
| hy3-x | Hy3 (X) | 192,000 | **64,000** | 推理·工具调用 | 0.05 |
| hy4-preview | Hy4 preview | **960,000** | **64,000** | 推理·工具调用 | 0.29 |
| hy4-preview-x | Hy4 preview (X) | **960,000** | **64,000** | 推理·工具调用 | 0.29 |
| hunyuan-2.0-thinking | Hunyuan-2.0-Thinking | 128,000 | **24,000** | 推理·工具调用 | 0.04 |
| hunyuan-chat | Hunyuan-Turbos | 200,000 | **8,192** | 工具调用 | — |
| space-bunny | Space-Bunny | **1,000,000** | **128,000** | 推理·工具调用 | 0.03 |
| auto | Auto（自动路由） | 256,000 | **32,000** | 平台自动选择 | — |
| default | Default（默认档） | 200,000 | **24,000** | 工具调用 | 2.20 |
| hunyuan-image-alpha | Hunyuan Image Alpha | —（目录未下发） | — | 图像生成，非对话模型 | — |

---

## 5. 跨平台同名模型对比（直观对比同一底层模型在两平台的参数差异）

| 底层模型 | 平台 | 上下文窗口 | 最大输出 | 积分倍率 | 差异要点 |
|---|---|---:|---:|---:|---|
| GLM-5.3 | Trae (dev) | 116,000 | 16,000 | 0.78 | Trae 标准档窗口最小；**max 档与 WB 同为 1M** |
| GLM-5.3 | Trae (max) | 1,000,000 | 64,000 | 0.78 | 与 WB 一致 |
| GLM-5.3 | WorkBuddy | 1,000,000 | 64,000 | 0.79 | 输出上限同 64K |
| GLM-5.3-Flash | Trae | 116,000 / 1,000,000 (max) | 16,000 / 64,000 | 0.06 | 两档；WB 直出 1M |
| GLM-5.3-Flash | WorkBuddy | 1,000,000 | **131,072** | 0.06 | **全场最大输出** |
| GLM-5.2 | Trae (dev) | 116,000 | 16,000 | 0.78 | — |
| GLM-5.2 | Trae (max) | 1,000,000 | 64,000 | 0.78 | — |
| GLM-5.2 | WorkBuddy | 1,000,000 | 64,000 | 0.79 | 完全一致 |
| GLM-5.1 / 5.0 | WorkBuddy | 200,000 | 48,000 | 0.79/0.80 | Trae 侧 5.1 为 invisible 且仅 116K/16K |
| MiniMax-M3 | Trae (dev/max) | 116,000 / 1,000,000 | 16,000 / 64,000 | 0.26 | dev 档偏小 |
| MiniMax-M3 | WorkBuddy | **512,000** | **64,000** | 0.25 | 单档 512K，输出同 64K |
| Kimi-K3 | Trae (dev/max) | 200,000 / 1,000,000 | 32,000 / 64,000 | 1.83 | max 档 200 轮 |
| Kimi-K3 | WorkBuddy | 1,000,000 | 32,000 | 1.62 | 输出上限 32K，低于 Trae max 档 |
| Kimi-K2.8-Preview | Trae (dev/max) | 200,000 / 1,000,000 | 32,000 / 64,000 | 0.98 | — |
| Kimi-K2.8-Preview | WorkBuddy | 1,000,000 | 64,000 | 0.77 | — |
| DeepSeek-V4-Flash | Trae (dev/max) | 116,000 / 1,000,000 | 16,000 / 64,000 | 0.15–0.20 | — |
| DeepSeek-V4-Flash | WorkBuddy | 1,000,000 | **50,000** | 0.17 | 输出介于两档之间 |
| DeepSeek-V4.1-Flash | Trae (dev/max) | 116,000 / 1,000,000 | 16,000 / 64,000 | 0.15 | — |
| DeepSeek-V4.1-Flash | WorkBuddy | 1,000,000 | **128,000** | 0.11 | **输出上限显著更高** |
| DeepSeek-V4-Pro | Trae (max) | 1,000,000 | 64,000 | 0.72 | 仅 Official 版可见 |
| DeepSeek-V4-Pro | WorkBuddy | 1,000,000 | **128,000** | 0.51 | 输出上限翻倍、倍率更低 |
| Qwen3.7/3.8 系列 | Trae (dev/max) | 200,000 / 1,000,000 | 32,000 / 64,000 | 0.08–1.50 | WB 平台无 Qwen 目录 |

---

## 6. 关键发现与选型建议

### 6.1 关键发现

1. **上下文窗口的「双档制」是 Trae 平台的核心特征**：绝大多数模型下发 `dev`（116K–256K）与 `max`（1,000,000）两套参数。默认走 dev 档；需要 1M 窗口时必须走 max 档（网关按 `context_window_tokens.max` 自动匹配，对应 `__max` 上游模型名）。
2. **最大输出 token 的天花板由平台决定，与模型品牌无关**：Trae 全系 dev 档输出 16K–32K、max 档统一 64K；WorkBuddy 则按模型差异化下发（8K–131K）。需要大输出（>64K）时只有 WorkBuddy 通道可满足（glm-5.3-flash 131,072、deepseek-v4.1-flash / v4-pro / space-bunny 128,000）。
3. **`context_window_tokens ≠ prompt_max_tokens`**：Trae 侧输入上限恒比标称窗口小 16K–64K。按标称窗口塞满输入必然失败，应以 `prompt_max_tokens` 为输入保护线。
4. **单轮工具调用轮数（max_turn）分两档**：70 轮（Doubao/GLM-5.2/DeepSeek/MiniMax/Step 系）与 200 轮（Kimi/Qwen 系）；自定义接入为 200–500 轮。长 Agent 任务优先选 200 轮档模型。
5. **两平台目录为账号池级统一**，模型可见性与账号身份无关；实际可用性由网关探活结果（`model-status.json`）逐模型学习，全部关键模型探活为 usable（2026-09-11 ~ 09-22 间确认）。
6. **虚拟模型 vm/unified-chat 的窗口声明取候选最小值（168,000）**，这是路由守门的正确姿势——即使候选含 1M 模型，声明也以最弱候选为准。

### 6.2 按场景选型速查

| 场景 | 推荐模型 | 理由 |
|---|---|---|
| 超长上下文（接近 1M） | wb/glm-5.3、wb/kimi-k3-1、wb/deepseek-v4.*、trae 各模型 max 档 | 1,000,000 窗口 |
| 大输出（>64K） | wb/glm-5.3-flash（131K）、wb/deepseek-v4.1-flash / v4-pro（128K） | 仅 WorkBuddy 通道支持 |
| 低成本高频 | wb/hy3（免费）、wb/space-bunny（0.03）、trae/glm-5.3-flash（0.06）、wb/hunyuan-2.0-thinking（0.04） | 倍率最低 |
| 深度推理/复杂代码 | trae/glm-5.3、wb/glm-5.3、wb/kimi-k2.8-preview、trae/qwen3.8-max | 推理模型，200 轮档优先 |
| 多模态输入 | trae/glm-5.3-flash(-x)、wb/glm-5v-turbo、trae/kimi-k3 | 目录标记 multimodal |
| Claude Code 客户端兜底 | 按 `model-fallback.json`：claude-* → glm-5.1 → glm-5 → qwen3.6-plus | 已配置映射 |

---

## 7. 附录

### 7.1 探测命令与脚本路径

- Trae 目录：`POST {TRAE_API_HOST}/api/ide/v1/get_detail_param`（实现：`src/upstream/client.js` → `getModelDetailParam()`；目录归一化：`src/models/catalog.js`）
- WorkBuddy 目录：`GET {chatHost}/console/enterprises/personal/models`（实现：`src/workbuddy/chat.js` → `fetchCatalog()`）
- 可用性探活持久化：`output/.trae-api/model-status.json`（`src/models/availability.js`，unavailable TTL 7 天）
- 目录元数据落库：SQLite `catalog_models` 表（`src/models/catalog-meta.js`，含 maxInputTokens/maxOutputTokens 字段指纹）

### 7.2 术语对照

| 术语 | 上游字段 | 含义 |
|---|---|---|
| 上下文窗口 | `context_window_tokens`（Trae）/ `maxInputTokens`（WB） | 模型可处理的总 token 窗口 |
| 输入上限 | `prompt_max_tokens`（Trae） | 单请求输入侧保护上限，恒 ≤ 上下文窗口 |
| 最大输出 | `max_tokens`（Trae）/ `maxOutputTokens`（WB） | 单次回复可生成的 token 上限 |
| 单轮对话上限 | `max_turn` | 一次会话内工具调用/多轮交互轮数上限 |
| dev / max 档 | `__dev` / `__max` 上游模型名后缀 | 标准档 / 长上下文档 |

### 7.3 数据有效性声明

- 本报告所有参数为 2026-10-06 实时探测值，**参数定义来源均为平台上游下发**（非本地推断）；
- 上游可能随时调整参数，建议以网关 `GET /v1/models`（转发密钥）或管理面「模型目录」为准做周期性复核；
- 积分倍率（credits rate）为平台计费参考，实际扣费以账号权益包为准；
- 账号 ID 已做脱敏处理（仅保留前 8–12 位），完整凭据经 AES-256-GCM 加密存储于 `output/.trae-api/trae-relay.db`。
