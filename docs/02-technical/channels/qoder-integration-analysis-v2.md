# Qoder 接入分析与实施方案（v3 — 双区域实证修订）

> ## ✅ 已实施（2026-10-13）
>
> P1 / P2 / P3 全部落地并通过验证：
>
> | 阶段 | 内容 | 验证 |
> |---|---|---|
> | P1 | 双区域凭据导入（`src/qoder/crypto.js` + `local.js`），`accounts.qoder_realm` 列 | 两个 realm 均解出真 `dt-`/`drt-` token；幂等导入（同 realm+uid 更新） |
> | P2 | 每日积分领取（`src/qoder/rewards.js` + `jobs/qoder-rewards.js` + `routes/qoder.js`） | 双区域活动查询 200；已领取幂等 `replayed:true` 且额度不重复；`alreadyToday` 正确计数 |
> | P3 | 模型目录同步（`src/qoder/catalog.js`） | 国内版 COSY 14 个模型；国际版 QMC 缓存 18 个 / COSY 17 个；`qfmodel` 双区域 `is_free=true, price_factor=0` |
>
> 测试：`node src/test/qoder.test.js`（50 项单测）+ `node scripts/verify/test-qoder-integration.js`
> （28 项真实上游集成测试）全部通过；既有全量测试 357 项无回归。
>
> **实施与运维细节见 [`qoder-integration-guide.md`](qoder-integration-guide.md)**，
> 本文保留为分析与实证记录。

> ## v3 修订说明（本轮）
>
> 本机同时装有国际版（`C:\opt\workstations\agents\Qoder`）与国内版（`C:\opt\workstations\agents\Qoder CN`）。
> 本轮解包国内版并实测，**推翻了 v2 关于对话转发的一个关键判断**，同时**国内版签到已实测成功**：
>
> | v2 结论 | v3 实证 | 影响 |
> |---|---|---|
> | 「新版协议纯 Bearer，转发可行」 | **只对国际版成立**。国内版 `gateway.qoder.com.cn/model/v1/*` 实测 **503**；国内版必须走老版 COSY 协议（`/algo/api/v2/...`） | 国内版转发面需实现 COSY 签名，工作量大幅上升；**国际版才适合做转发** |
> | 「积分端点双区域同构」 | **确认同构**，且国内版已实测领到 100 credits（`grantId` + `replayed:true` 幂等验证通过） | P2 可立即落地，国内版是更现实的试点 |
> | 「`qfmodel` 限免但不可调用」 | **限免属性双区域一致**（`is_free=true, price_factor=0`）；不可调用性仍未验证（仅目录字段） | 需逐个探测可调用集合 |
> | 「凭据可自动导入」 | **双区域均已解出真 token**（不同账号：国际版 `019f0dea…`，国内版 `01a1346c…`） | `src/qoder/local.js` 按 app 目录名分叉即可 |
>
> **COSY 签名链路已完全打通**（国内版 `/algo/api/v2/model/list` 返回 200，68KB 模型目录），
> 这是本轮最硬的技术产出——意味着即使国内版要做转发，路径也是通的。

---

# Qoder 接入分析与实施方案（v2 — 基于开源项目实证修订）

> **v2 修订说明**：v1（`docs/02-technical/channels/qoder-integration-analysis.md`）基于对客户端 asar 的静态分析，
> 得出三个结论。结合 6 个开源逆向项目与本机实测后，**其中两个结论是错的**，本文予以纠正：
>
> | v1 结论 | v2 实证 | 影响 |
> |---|---|---|
> | 「Qoder 无法像 ZCode 那样读文件拿到凭据，只能手动粘贴」 | **错**。`auth.v1.dat` 是 Chromium os_crypt v10，密钥在同目录 `Local State` 的 `os_crypt.encrypted_key`（DPAPI 包裹）。本机已成功解出 `dt-`/`drt-` 真 token | 可全自动导入，与 ZCode 完全同构 |
> | 「积分端点未实证，必须抓包」 | **已实证**。`GET /sash/api/v1/me/campaigns` 直接返回每日 100 Credits 活动，含「每日 10:00（UTC+8）刷新，领取后 30 天有效」原文 | 无需抓包，可直接写码 |
> | 「对话转发本期不做」 | **部分错**。新版端点 `POST api2-v2.qoder.sh/model/v1/chat/completions` 纯 Bearer、OpenAI 兼容 SSE，本机已打通并拿到 usage | 转发可行，但 `Cosy-*` 头风险仍在，建议灰度 |
>
> 另有一个 v1 未覆盖的关键事实：**Qwen3.8-Flash 限免在本机 catalog 里是 `is_free: true, price_factor: 0.0`**，
> 且它在上游 chat 端点上返回 `invalid_model_error`（该 key 仅目录可见，非可调用模型名）。

---

## 1. 参考项目评估（6 个）

| 项目 | 语言 | 成熟度 | 对本项目的价值 |
|---|---|---|---|
| [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) | Python | **最高**（v1.3.3，140★，2026-10-09 仍在推） | **主要参考**。`qoder_accounts.py` 有完整的凭据扫描/解密、签到、活动、额度实现；`qoder_sign.py` 有 COSY 签名 + QMC 目录解密；有 20+ 测试文件 |
| [bzym2/QoderGateway](https://github.com/bzym2/QoderGateway) | Python + TS | 高 | `docs/qoder-protocol-research.md` 是**唯一系统性的协议文档**，两代协议对照、PKCE device flow、混淆字符串解密方法都在里面 |
| [cubk1/qoder2api](https://github.com/cubk1/qoder2api) | Java | 中 | 老版 COSY 协议的 Java 参考（`Signature.java` 只有 1.2KB，签名就是一行 md5） |
| [nine710/qoderapi_cpa](https://github.com/nine710/qoderapi_cpa) | Java | 中 | 协议转译层写得干净（`UpstreamPayloadAssembler` 16KB），适合对照 Qoder 请求体结构 |
| [okky-x0f/qoder-creator](https://github.com/okky-x0f/qoder-creator) | Python | 低（单文件 111KB） | 与 bzym2 同源的批量注册脚本，**不建议参考**（涉批量注册，属风控对象） |
| [itandelin/qoder-free](https://github.com/itandelin/qoder-free) | Python | 低（GUI 132KB） | 设备重置工具，涉规避风控，**不建议参考** |

**结论：技术参考取 `qoder2api-hub` + `QoderGateway` 的协议文档，这两个足以支撑完整接入，无需抓包。**

---

## 2. 实证：本机已跑通的三件事

以下均在 `C:\opt\workstations\project\web\RelayGate\scripts\` 下有可复现脚本，
全部只读（除显式设置 `QODER_TRY_CLAIM=1` 外不发起写操作）。

### 2.1 凭据解密（全自动导入的基石）

```js
// scripts/verify/qoder/verify-qoder-credential-read.js —— 输出：
app dir : C:\Users\bing\AppData\Roaming\com.qoder.app.stable
encrypted_key prefix: DPAPI
DPAPI 解出 key 长度: 32 bytes
auth.v1.dat 前缀: "v10" size: 417
token     : dt-VGt…(len=27)
refresh   : drt-ND…(len=28)
expiresAt : 2026-11-12T08:02:16Z
user      : {"id":"019f0dea-…","name":"Lice","email":"werrice@outlook.com"}
```

链路（与 ZCode 的 `zcode/local.js` 结构完全同构，只是换了一套加密）：

```
%APPDATA%\com.qoder.app.stable\Local State
  └─ os_crypt.encrypted_key (base64) → 剥 "DPAPI" 前缀 → CryptUnprotectData → 32 字节 AES key
%APPDATA%\com.qoder.app.stable\auth.v1.dat
  └─ "v10" + nonce(12) + AES-256-GCM(ciphertext+tag) → 解密 → JSON
     { schemaVersion, token(dt-), refreshToken(drt-), expiresAt, refreshTokenExpiresAt, user{id,name,email} }
```

**国内版路径不同**：`com.qodercn.app.stable` + `~/.qoder-cn/`，另有 CLI 形态
`~/.qoder/.auth/user`（AES-128-CBC，key=iv=`machine_id` 前 16 字节）。三种都要扫。

Node 侧实现要点（本机已验证）：
- DPAPI 无原生绑定，借 `powershell.exe` 调 `[System.Security.Cryptography.ProtectedData]::Unprotect`
  （**必须经 stdin 传 base64**，命令行传参会被 PowerShell 当裸 token 解析而 ParserError）
- AES-256-GCM 用 `node:crypto` 原生支持，无需自己实现

### 2.2 每日 100 积分（活动平台）

```json
// GET https://openapi.qoder.sh/sash/api/v1/me/campaigns
{
  "showCampaign": true,
  "claimable": false,
  "campaigns": [{
    "campaignId": "01a130ed-591d-7478-b790-5cba595cd2a7",
    "campaignKey": "act-20261013-517",
    "actionType": "CLAIM_BENEFIT",
    "claimStatus": "CLAIMED",
    "benefit": {
      "kind": "CREDITS", "amount": 100,
      "modelScope": {"modelSeries": {"key": "ALL_MODELS"}},
      "validity": {"mode": "RELATIVE_DAYS", "days": 30}
    },
    "startAt": 1791856800, "endAt": 1791943140,
    "placements": [{"content": {"zh": {
      "title": "每天领 100 Credits",
      "description": "每日 10:00（UTC+8）刷新，领取后 30 天有效",
      "detailUrl": "https://docs.qoder.com/zh/events/100credits"
    }}}]
  }]
}
```

**用户描述的三个条件全部被上游原文证实**：100 积分 / 每日 10:00（UTC+8）刷新 / 领取后 30 天有效。
`validity.mode = "RELATIVE_DAYS", days = 30` 明确是「领取后 30 日」而非「固定月底过期」——
这正是 v1 风险清单里留的那个问号，现在有答案了。

额度口径（`GET /api/v2/quota/usage`）：

```json
{"userType":"personal_professional_trial","usageType":"credits",
 "userQuota":{"total":300,"used":0,"remaining":300,"unit":"credits"},
 "addOnQuota":{"total":100,"used":0,"remaining":100,"unit":"credits"},
 "expiresAt":1793088145867,"isQuotaExceeded":false}
```

注意 `userQuota` + `addOnQuota` 两段：签到领的 100 进 `addOnQuota`（赠送/签到额度），
与 ZCode 的 `tokenBuckets` 隔离思路同构——**不能把两段加总后混进 RelayGate 的积分口径**。

### 2.3 对话转发（新版协议）

```js
// scripts/verify/qoder/verify-qoder-chat-endpoint.js —— model=lite
POST https://api2-v2.qoder.sh/model/v1/chat/completions
HTTP 200 OK | content-type: text/event-stream
data: {"choices":[{"delta":{"content":"P","role":null},"index":0}],...,
       "object":"chat.completion.chunk","usage":null}
```

**纯 Bearer，无 COSY 签名，标准 OpenAI SSE**。请求体只需：

```json
{"model":"lite","messages":[{"role":"user","content":"ping"}],"stream":true,
 "stream_options":{"include_usage":true},
 "metadata":{"context":{"request_id":"<uuid>","request_set_id":"<uuid>",
                        "session_id":"<uuid>","task_id":"common","client_type":"qodercli"}}}
```

`model=qmodel`（Qwen3.7-Plus）也通，返回带 `reasoning_content`。

---

## 3. 接入方案（修订后）

### 3.1 端点清单（实证，非推测）

| 用途 | 方法 | 端点 | 头 |
|---|---|---|---|
| 用户信息 | GET | `openapi.qoder.sh/api/v1/userinfo` | Bearer |
| 积分余额 | GET | `openapi.qoder.sh/api/v2/quota/usage` | Bearer |
| 套餐 | GET | `openapi.qoder.sh/api/v2/user/plan` | Bearer |
| 活动列表 | GET | `openapi.qoder.sh/sash/api/v1/me/campaigns` | Bearer + **桌面端头** |
| 活动领取 | POST | `openapi.qoder.sh/sash/api/v1/me/campaigns/{id}/claim` | Bearer + **桌面端头** |
| 旧签到状态 | GET | `openapi.qoder.sh/sash/api/v1/me/daily-check-in/status` | Bearer |
| 旧签到领取 | POST | `openapi.qoder.sh/sash/api/v1/me/daily-check-in/claim` | Bearer |
| token 刷新 | POST | `openapi.qoder.sh/api/v1/jobToken/refresh` `{"refresh_token":"drt-…"}` | 无 |
| **对话（新版）** | POST | `api2-v2.qoder.sh/model/v1/chat/completions` | Bearer + `X-Request-ID`/`X-Session-ID` |
| 对话（老版） | POST | `api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation` | COSY 签名 |

域名按区域：国际 `.qoder.sh`，国内 `.qoder.com.cn`（`openapi.qoder.com.cn` / `gateway.qoder.com.cn`）。

### 3.2 桌面端头是领取功能的生死线

这是 `qoder2api-hub` 踩出来的最有价值的经验（其 `desktop_headers()` docstring 记录了完整过程）：

```
Authorization: Bearer <token>
User-Agent: Qoder
cosy-clienttype: 10          // 桌面端；CLI=5，QoderWork=6
cosy-version: 0.4.3
cosy-machineos: x86_64_win32
cosy-machinehostname: DESKTOP-QODER
cosy-machineid / cosy-machinetoken / cosy-machinetype / cosy-machinecode
```

**两层坑**：
1. 缺 `User-Agent` / `cosy-clienttype` / `cosy-version` → 服务端**不报错但返回空活动列表**
2. 「机器头半套」问题：六头**全发派生假值** → 服务端判定非官方客户端，把
   「每日领取 100 Credits」整条过滤掉，列表只剩 VIEW_DETAILS 类。
   逐头隔离实测：六头任一个单独出现 → 活动可见；六头全发 → 被过滤。

策略：有原生身份（官方 `runtime-info.exe` 输出）时发全套；无原生桥时**一个机器头都不发**。
 RelayGate 部署在服务器上，属「无原生桥」场景 → 走 omitted 分支。
 这意味着**国际版可能看不到活动**（官方要求真实 UMID 机器身份，每 50 分钟刷新），
 国内版不发头是正确行为。这是已知限制，必须在 UI 上明示，不能静默失败。

### 3.3 限免模型（Qwen3.8-Flash）

本机 `~/.qoder/.models/<uid>/catalog-v6` 是 QMC v1 加密（HKDF-SHA256(uid) + AES-256-GCM），
解密后可拿到完整目录。相关条目：

| key | display_name | price_factor | is_free | 上游可调用 |
|---|---|---|---|---|
| `qfmodel` | Qwen3.8-Flash | **0.0**（原价 0.1） | **true** | **否**（`invalid_model_error`） |
| `qmodel_38max` | Qwen3.8-Max | 0.5 | true | 否（同报错） |
| `qmodel` | Qwen3.7-Plus | — | false | **是** |
| `lite` | 轻量 | — | — | **是** |

**重要修正**：`qfmodel`（Qwen3.8-Flash）虽然目录里标 `is_free: true, price_factor: 0.0`，
但在 chat 端点上报 `Unsupported model`。所以「限免」的正确落地形态是：

- **目录同步**：把 `is_free` / `price_factor` 带进 RelayGate 的模型列表，面板显示「限免」徽标
  （对齐 Trae 既有的 `parseContactRate` 折扣语义）
- **可调用集合要单独测**：不能假设 `is_free` 等于可调用。上线前用最小请求逐个探，
  结果写入 `models/availability.js`（本仓已有 `markUsable` / `markUnavailable` 机制）
- **计量口径**：`price_factor: 0.0` 的模型在 `token-credit-metering` 侧应记 0 消耗，
  否则「今日消耗」虚高

### 3.4 架构对接（v1 表格的修正）

v1 说「`src/credentials/db.js` 无需加列」是对的，但漏了两处必须改的：

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/platform/variant.js` | 新增 `QODER` 变体（域名/路径/业务码/能力位/`realm`） | 纯增量 |
| `src/credentials/db.js` | 加 `qoder_realm` 列（`cn`/`intl`） | 域名选择依赖它，**必须加** |
| `src/qoder/local.js` | 三处凭据扫描 + os_crypt 解密 | 新建，参照 `zcode/local.js` |
| `src/qoder/catalog.js` | QMC v1 解密 + 目录同步 | 新建 |
| `src/qoder/rewards.js` | campaigns / claim / quota | 新建，参照 `zcode/rewards.js` |
| `src/qoder/client.js` | HTTP 通道 + 桌面端头 | 新建 |
| `src/jobs/qoder-rewards.js` | 每日 10:00 后领取 | 自管时段，不改 `scheduler.js` |
| `src/routes/qoder.js` | `/v1/qoder/*` | 挂载于 `index.js` |
| `src/upstream/balance.js` | 加 `refreshQoderBalance` 分支 | 与 wb/zcode 并列 |
| `src/models/pricing-calib.js:62` | **加 qoder 分支** | 现有三元 `p==='workbuddy'?'wb':'trae'` 会把 qoder 费率误归 trae |
| `web/.../CredentialsPage.tsx:523` | **加 qoder 分支** | 现有 `platformOf(a)!=='zcode'` 会导致 qoder 账号显示错误操作按钮 |

**无需改**（已按能力位分流）：`checkin-all.js`、`pool.js`、`scheduler.js`、
`growth-*.js`、`workbuddy/chat.js`、`trae-usage.js`。

`src/` 下现存 153 处 edition 字面量，除上表两处外均无需改动（其余是 WorkBuddy 专属或显式白名单）。

---

## 4. 分期（修订）

| 期 | 内容 | 前置 | 估时 |
|---|---|---|---|
| **P1** | 本机凭据自动导入（三处扫描 + os_crypt/QMC 解密）+ 账号页签 | 无（已实证） | 1–2 天 |
| **P2** | 积分查询 + 每日 10:00 自动领取活动 + 通知 | P1 | 1–2 天 |
| **P3** | 目录同步 + 限免徽标 + 可用性探测 | P1 | 1 天 |
| **P4** | 转发面（新版协议，OpenAI 兼容 SSE） | P1 + **独立小号验证** | 3–5 天 |

P1–P3 合计约 3–5 天，代码量约 800–1000 行（对照 `src/zcode/` 的成熟结构）。
**P0 抓包期已取消**——协议已由开源项目 + 本机实测双重确认。

### 为什么 P4 仍建议放最后

新版协议虽已跑通，但：
1. 只在本机单账号验证过，未验证多账号并发、风控触发条件、限额行为
2. RelayGate 的 `transform/` 围绕 Trae `llm_utils_chat` 与 WorkBuddy `/v2/chat/completions` 建，
   Qoder 的 `metadata.context` 包裹形态需要新的请求构造与 SSE 解析分支
3. ZCode 的教训：`capability.chat=false` 是有意识的边界。Qoder 应先以运营面上线，
   转发面等独立小号验证后再开

---

## 5. 风险（修订）

1. **国际版可能领不到积分**：官方要求真实 UMID 机器身份（`runtime-info.exe` 每 50 分钟刷新），
   服务器部署无此组件时活动列表可能为空。这是 `qoder2api-hub` 记录在案的已知限制。
   **缓解**：UI 明示「国际版需本机运行官方客户端组件」，不要把空列表显示成「今天没有活动」。
2. **`qfmodel` 限免但不可调用**：目录 `is_free=true` 与上游可调用性不一致。
   必须以实测为准，不能按目录字段推断。
3. **计量口径必须隔离**：Qoder 是 `credits`（本机 300 + 100 两段），
   RelayGate 既有积分体系是 Trae/WorkBuddy 的 `credit`。**禁止把两段加总后写入
   `accounts.balance` / `entitlement_snapshot.packs`**，否则重演 ZCode 那次
   「totalUsed 从 5,437 变 902,822,370」的污染事故。参考
   `docs/02-technical/channels/zcode-integration.md` 的「计量口径隔离」一节。
4. **`dt-` token 有效期**：本机 `expiresAt` 约 30 天，`drt-` 约 1 年。
   需实现 `jobToken/refresh` 自动续期（`qoder2api-hub` 有此实现，QoderGateway 承认未做）。
5. **法律与合规**：活动领取是「自动领取本机已登录账号自己的权益」，
   与 RelayGate 现有 Trae/WorkBuddy 签到同性质。但**不要参考 `qoder-creator` /
   `qoder-free` 那两个项目**——它们涉批量注册与设备重置，属风控对象，不在本项目范围内。

---

# 附录 A：国内版 / 国际版差异（v3 新增，全部本机实测）

> 数据来源：`scripts/verify/qoder/verify-qoder-realm-diff.js` 生成的 `logs/qoder-realm-diff.md`。

## A.1 账号与凭据

| 项 | 国际版 | 国内版 |
|---|---|---|
| app 目录 | `%APPDATA%\com.qoder.app.stable` | `%APPDATA%\com.qodercn.app.stable` |
| home 目录 | `~\.qoder` | `~\.qoder-cn` |
| 主域名 | `qoder.sh` | `qoder.com.cn` |
| uid | `019f0dea-ce95-75ac-8e60-b5e973f3ed4f` | `01a1346c-5782-76dd-aa02-89998cad1630` |
| 账号 | `werrice@outlook.com`（sso.github） | `874741101@qq.com`（sso.aliyun） |
| token | `dt-VGt…` len=27 | `dt-4Xp…` len=27 |
| expiresAt | 2026-11-12T08:02:16Z | 2026-11-12T08:41:21Z |
| 加密链路 | os_crypt v10 + DPAPI | **同左，完全同构** |

**结论：凭据层可以统一实现，只需按 app 目录名分叉。** 两侧是不同账号（uid 不同），
账号池必须带 `realm` 字段区分。

## A.2 服务端点（客户端 `endpoint-cache.json` 实证）

| 职能 | 国际版 | 国内版 |
|---|---|---|
| openapi | `openapi.qoder.sh` | `openapi.qoder.com.cn` |
| center | `center.qoder.sh` | `gateway.qoder.com.cn` |
| infer | `api3.qoder.sh` | `gateway.qoder.com.cn` |
| fast | `api6.qoder.com.cn` ⚠️ | `gateway.qoder.com.cn` |

⚠️ **陷阱**：国际版的 `fastEndpoint` 指向 `api6.qoder.com.cn`（一个 `.com.cn` 域名）。
**不能靠域名后缀判断 realm**，必须以 app 目录 / home 目录为准。

**结构性差异**：国际版按职能拆多域名；国内版统一走 `gateway.qoder.com.cn` 单域名。

## A.3 对话协议（本轮最重要的发现）

| 项 | 国际版 | 国内版 |
|---|---|---|
| 新版 OpenAI 兼容 | `POST api2-v2.qoder.sh/model/v1/chat/completions`，纯 Bearer，**实测 200** | `gateway.qoder.com.cn/model/v1/*`，**实测 503** |
| 老版 COSY | `POST api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation` | `POST gateway.qoder.com.cn/algo/api/v2/...`，**实测 200** |
| 签名 | `Bearer COSY.<payload>.<sig>`，`sig = md5(payload\ncosyKey\ndate\nbody\npath)` | 同左 |
| 请求体 | `qoder_encode(json)`（自定义 Base64 变体：三段重排 + 自定义字母表） | 同左 |
| 模型路由 | `x-model-key` 头 | 同左 |

**这意味着**：
- 国际版转发面 = 纯 Bearer + 标准 OpenAI SSE，**工作量低**
- 国内版转发面 = 必须实现 COSY 全套签名（RSA 包裹会话密钥 + AES-128-CBC 身份体 + 自定义 Base64），**工作量高**
- RelayGate 部署在国内 → **国内版是主要场景，但国内版恰恰是难的那一版**

## A.4 COSY 签名实现要点（已实测打通）

`scripts/verify/qoder/verify-qoder-cn-cosy.js` 已实现并验证。七个关键点，错一个就 `{"code":"101","message":"Signature invalid"}`：

1. **`cosyVersion` = `"1.1.64"`**——官方客户端内置常量，**不是**桌面版版本号 `0.4.3`
2. **`ideVersion` = `""`**（空串）
3. **`version` = `"v1"`**
4. **identity 9 键**：`name` / `aid` / `uid` / `yx_uid` / `organization_id` /
   `organization_name` / `user_type` / `security_oauth_token` / `refresh_token`
   （`user_type` = `personal_profession_trial`，注意是 profession 不是 professional）
5. **头集合 16 项缺一不可**：`cosy-data-policy: AGREE`、`cosy-clientip`、
   `login-version: v2`、`cosy-clienttype: 5`、`accept-encoding: identity` 等
6. **RSA 公钥 PEM 第 3 行是 `…236FZz73In/…`**（`FZz`）——转录错一个字符会导致
   exponent 解析失败，签名必然错
7. **GET 请求必须带同款 body**（`qoder_encode("{}")`）——服务端校验签名与 body 一致，
   裸 GET 会 403。Node 的 `fetch` 不允许 GET 带 body，需用 `node:https`

设备指纹按 uid 稳定派生（`qoder_fingerprint.py` 同构）：
- `machine_id` = `md5("machine:"+uid).hexdigest()[:36]`
- `machine_type` = `md5("machinetype:"+uid).hexdigest().replace("-","")[:18]`
- `machine_token` = `sha512("machinetoken:"+uid)` → base64url → `[:43]`

实测输出（与官方 Python 实现逐字节一致）：
```
machineId  : 0fbb51733775874877d64abb62ae4068
machineType: fd1f3ad7791e819cab
machineTok : ezbdprqMGht-g0YiPZZIw5rvHAojUjaGaMIrnddnBe4
→ GET /algo/api/v2/model/list?Encode=1  HTTP 200  len 68155
```

## A.5 积分活动（双区域同构，国内版已实测领取）

| 项 | 国际版 | 国内版 |
|---|---|---|
| 活动列表 | `openapi.qoder.sh/sash/api/v1/me/campaigns` | `openapi.qoder.com.cn/sash/api/v1/me/campaigns` |
| 领取 | `POST /sash/api/v1/me/campaigns/{id}/claim` | 同左 |
| 活动 key | `act-20261013-517` | `act-20261013-250` |
| 文案 URL | `docs.qoder.com/events/100credits` | `docs.qoder.cn/events/100credits` |
| 文案 | 「每天领 100 Credits / 每日 10:00（UTC+8）刷新，领取后 30 天有效」 | **逐字一致** |

**国内版领取实测记录**（`scripts/verify/qoder/verify-qoder-cn-checkin.js --claim`）：
```json
{"grantId":"01a13473-be68-7a01-a9f5-3c8263e633d2","status":"CLAIMED","replayed":false,
 "benefit":{"kind":"CREDITS","amount":100,"modelScope":{"modelSeries":{"key":"ALL_MODELS"}},
            "validity":{"mode":"RELATIVE_DAYS","days":30}},
 "claimedAt":"2026-10-13T08:49:22.99315Z","expiresAt":"2026-11-12T08:49:22.99315Z"}
```
- 领取后 `addOnQuota` 从「不存在」→ `{total:100, remaining:100}`，**100 积分到账**
- `expiresAt` 精确 = `claimedAt` + 30 天，证实「领取后 30 日」

**幂等性实测**（`scripts/verify/qoder/verify-qoder-cn-idempotent.js`）：对已领取活动重复 claim 两次，
均返回同一 `grantId` + `replayed: true`，总剩余积分恒为 400（300 base + 100 addOn）。**PASS。**

## A.6 额度结构

| 项 | 国际版 | 国内版 |
|---|---|---|
| userType | `personal_professional_trial` | 同左 |
| usageType | `credits` | 同左 |
| userQuota | 300 | 300 |
| addOnQuota | 100（领取后出现） | 100（领取后出现） |
| expiresAt | 2026-10-27 | 2026-10-27 |

**注意**：`userQuota` 与 `addOnQuota` 是两段独立额度，签到积分进 `addOnQuota`。
**禁止加总后写入 RelayGate 积分口径**（见 v2 风险清单第 3 条）。

## A.7 模型目录

| 项 | 国际版 | 国内版 |
|---|---|---|
| 模型数 | 18 | 14 |
| 获取方式 | QMC v1 本机缓存 `catalog-v6`，或 COSY `model/list` | **必须** COSY `/algo/api/v2/model/list`（动态） |
| 限免模型 | `qfmodel`（Qwen3.8-Flash）`is_free=true, price_factor=0` | **完全一致** |
| 国际版独有 | `ultimate`/`fast`/`performance`/`efficient`/`smodel`(Sonus)/`cmodel`(Cantus) | — |
| 国内版独有 | — | `q37fmodel`(Qwen3.7-Flash)、`gm51model`(GLM-5.2)、`mmodel`(MiniMax-M2.7) |
| 同名不同值 | `mmodel` = MiniMax-**M3** | `mmodel` = MiniMax-**M2.7** |
| CN 特色 | — | `qmodel_38max` 带错峰 4 折（22:00–08:00 UTC+8，`idle_time_model_credit_discount`） |

**QMC v1 解密格式**（`qoder_sign.py: qmc_decrypt`）：
```
envelope = base64( magic "QMC\x01"(4) + nonce(12) + AES-256-GCM(ct+tag) )
key = HKDF-SHA256(ikm=uid, salt="qoder-model-cache-enc", info="model-cache-v1", 32)
```
文件本身是 base64 文本（以 `UU1D` 开头），需按 utf8 读入后再 base64 解。

## A.8 对 RelayGate 方案的影响

1. **凭据层可统一**：`src/qoder/local.js` 按 `com.qoder.app.stable` / `com.qodercn.app.stable`
   两个目录名分叉扫描即可，解密代码完全相同。
2. **`variant.js` 必须带 `realm` 字段**：域名选择、协议选择（新版 vs COSY）、
   模型目录获取方式三者都依赖 realm。v2 里我写「加 `qoder_realm` 列」是对的，现在有更强的理由。
3. **运营面（P1/P2）双区域通用**：`/sash/api/v1/me/campaigns` + `/api/v2/quota/usage`
   仅域名不同，**国内版已实测可领，应作为首个试点**。
4. **转发面（P4）建议只做国际版**：国内版需完整 COSY 签名实现，且国内版 catalog
   必须动态拉取。若确需国内版转发，先复用 `src/qoder/cosy.js`（本轮已写好并验证）。
5. **限免模型双区域一致**：`qfmodel` `price_factor=0`，可用于计量层 0 消耗特判；
   但「is_free 是否等于可调用」仍未验证，上线前必须逐个探测。

---

## 附：可复现脚本

| 脚本 | 作用 |
|---|---|
| `scripts/verify/qoder/verify-qoder-credential-read.js` | 解密 `auth.v1.dat`，证明凭据可自动导入 |
| `scripts/verify/qoder/verify-qoder-dual-realm.js` | 双区域凭据解密对比 + 端点缓存对比 + 账号隔离确认 |
| `scripts/verify/qoder/verify-qoder-cn-checkin.js` | **国内版积分活动查询与领取**（`--claim` 实际领取） |
| `scripts/verify/qoder/verify-qoder-cn-idempotent.js` | 国内版领取幂等性验证（重复 claim 不重复发放） |
| `scripts/verify/qoder/verify-qoder-cn-cosy.js` | **国内版 COSY 签名打通**（`/algo/api/v2/model/list` → 200） |
| `scripts/verify/qoder/verify-qoder-cn-chat.js` | 国内版对话端点探测（新版 503 / COSY 超时挂起） |
| `scripts/verify/qoder/verify-qoder-catalog-diff.js` | CN/Intl 模型目录对比（COSY vs QMC v1 解密） |
| `scripts/verify/qoder/verify-qoder-realm-diff.js` | 生成完整双区域差异报告 → `logs/qoder-realm-diff.md` |
| `scripts/verify/qoder/verify-qoder-checkin.js` | 打 userinfo / quota / campaigns，输出活动与额度摘要 |
| `scripts/verify/qoder/verify-qoder-chat-endpoint.js` | 打新版 chat 端点，验证 SSE 与 usage |
| `scripts/inspect/parse-qoder-asar.js` | 解析 Qoder `app.asar` 头（离线，无 `@electron/asar` 依赖） |
| `scripts/inspect/extract-qoder-asar.js` | 抽取 asar 内指定文件 |

```powershell
node scripts/verify/qoder/verify-qoder-credential-read.js
node scripts/verify/qoder/verify-qoder-checkin.js
$env:QODER_CHAT_MODEL='qmodel'; node scripts/verify/qoder/verify-qoder-chat-endpoint.js
```

参考项目已克隆至 `/tmp/qoder-repos/`（临时目录，重启后需重新 clone）。
