# Qoder 接入说明（双区域每日积分自动领取 + 国际版对话转发）

> 接入范围：**账号运营面全量**（本机凭据导入双区域、手动粘贴 token 导入、
> 每日 100 Credits 积分活动查询与领取、额度查询、模型目录同步、定时任务）
> + **国际版单账号对话转发**。
> **不含**：国内版对话转发（同路径实测 503，需 COSY 老协议）、多账号负载均衡
> （上游并发与风控阈值未验证）。详见下方「国际版对话转发」与 `docs/01-architecture/known-limitations.md` F5。

Qoder 客户端每天可领 **100 Credits**（有效期 30 日），官方只在客户端内弹横幅，关闭就错过。
本模块在 RelayGate 内定时自动领取，并支持查询两段隔离的额度与同步模型目录（含限免标识）。

- 每日 **10:15**（本地时区）执行一轮 —— 上游规则是「每日 10:00（UTC+8）刷新」
- 有可领积分活动 → 自动 claim → 通知；已领取幂等跳过，不会重复发放
- 双区域（国内版 / 国际版）账号体系独立，**realm 随账号持久化**

## 它解决什么

| 能力 | 说明 |
|---|---|
| 每日积分领取 | 上游 `CLAIM_BENEFIT` + `CREDITS` 活动，100 credits / 30 天 |
| 额度查询 | `userQuota`（基础 300）与 `addOnQuota`（赠送/签到 100）**两段隔离展示** |
| 模型目录 | 国内版走 COSY 动态拉取，国际版可解密本机 QMC 缓存；含 `is_free` 限免标识 |
| 本机导入 | 解密桌面客户端 `auth.v1.dat`（Chromium os_crypt v10 + DPAPI），两个区域各一个账号 |
| 手动导入 | 粘贴 `dt-` access token 或凭据 JSON，realm 显式指定，默认在线验证；覆盖 Linux 部署与跨机接入 |
| 国际版对话转发 | `POST /v1/qoder/chat/completions`，纯 Bearer，OpenAI 兼容（**仅国际版、单账号**） |

## 双区域差异（核心）

Qoder 有**两套完全独立的账号体系**（uid 不同、不互通），域名与协议都不同：

| | 国内版（cn） | 国际版（intl） |
|---|---|---|
| 客户端目录 | `%APPDATA%\com.qodercn.app.stable` | `%APPDATA%\com.qoder.app.stable` |
| 家目录 | `~/.qoder-cn` | `~/.qoder` |
| 运营面基址 | `openapi.qoder.com.cn` | `openapi.qoder.sh` |
| 网关基址 | `gateway.qoder.com.cn` | `api2-v2.qoder.sh` |
| 对话协议 | COSY 老版（签名 + 自定义 Base64） | 新版 OpenAI 兼容（纯 Bearer） |
| 模型目录 | COSY `model/list`（14 个） | QMC 缓存 / COSY（18 / 17 个） |
| 账号示例 | `874741101@qq.com`（sso.aliyun） | `werrice@outlook.com`（sso.github） |

**realm 只能由「扫到哪个客户端目录」确定，之后随账号持久化（`accounts.qoder_realm`）。
严禁按域名后缀推导** —— 国际版客户端的 `fastEndpoint` 实测指向 `api6.qoder.com.cn`，
一个 `.com.cn` 域名，靠 host 猜会把国际版误判成国内版。这条约束由单测
`关键实证：国际版 fastEndpoint 是 .com.cn 域名，realm 不得由域名推导` 守门。

### realm 驱动什么

```
realm ─┬─→ 域名选择      variant.qoderOpenapiBase(realm) / qoderGatewayBase(realm)
       ├─→ 对话协议      realms[realm].chatProtocol（cosy | openai）
       └─→ 目录获取方式  catalog.syncCatalog()：cn 只能 COSY，intl 可 QMC 缓存
```

## 上游链路（实证）

运营面双区域同构，仅域名不同。以国内版为例：

```
GET  https://openapi.qoder.com.cn/api/v1/userinfo                  ← 身份校验
GET  https://openapi.qoder.com.cn/api/v2/quota/usage               ← 两段额度
GET  https://openapi.qoder.com.cn/sash/api/v1/me/campaigns         ← 活动列表
POST https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/{id}/claim  ← 领取
```

活动条目形态：

```jsonc
{
  "campaignId": "act-20261013-250",
  "campaignKey": "act-20261013-250",
  "actionType": "CLAIM_BENEFIT",          // 可领取；VIEW_DETAILS 是纯展示
  "claimStatus": "CLAIMABLE",             // CLAIMABLE | CLAIMED
  "benefit": {
    "kind": "CREDITS",                    // 只处理 CREDITS
    "amount": 100,
    "validity": { "mode": "RELATIVE_DAYS", "days": 30 }   // 领取后 30 天，非月底
  },
  "placements": [{ "content": { "zh": { "title": "每天领 100 Credits",
                                        "description": "每日 10:00（UTC+8）刷新…" } } }]
}
```

领取响应：`{ grantId, status:"CLAIMED", replayed, benefit, campaignId, campaignKey, claimedAt, grantedAt, expiresAt }`

关键实测结论（写代码时勿凭直觉改）：

1. **桌面端请求头是 load-bearing 的**。`/sash/*` 必须带
   `User-Agent: Qoder` / `cosy-clienttype: 10` / `cosy-version: 0.4.3`。
   缺了**不报错但返回空活动列表**——最难排查的一类失败。
2. **`cosy-machine*` 六头必须整体省略**。本服务跑在服务器、无官方原生桥，
   发派生假值会被服务端判定非官方客户端，把「每日 100 Credits」整条过滤掉
   （qoder2api-hub 逐头隔离实测）。国际版在服务器部署时可能因此看不到活动，
   代码里 `omitMachineHeaders: true` 并会在通知中明示。
3. **幂等靠上游保证**。对已领取活动重复 claim 返回同一 `grantId` + `replayed:true`，
   额度不重复增加。实测国内版 `grantId 01a13473-be68-7a01-a9f5-3c8263e633d2`，
   重复领取后 `addOnQuota` 仍是 100。
4. **`is_free` ≠ 可调用**。`qfmodel`（Qwen3.8-Flash）在目录里 `is_free=true, price_factor=0`，
   但在 chat 端点返回 `invalid_model_error`。可调用集合必须实测探测，
   不能按目录字段推断（单测 `关键实证：is_free ≠ 可调用` 守门）。
5. **`mmodel` 同名不同值**：国际版 MiniMax-M3，国内版 MiniMax-M2.7。
   目录必须按 realm 分开存，禁止合并成一张全局表（单测守门）。
6. **国内版 `/model/v1/*` 实测 503**，对话只能走 COSY 老协议（未实现转发）。
7. **对话面不需要运营面那三头**。`/model/v1/chat/completions` 纯 `Authorization: Bearer`
   即可，带 `User-Agent: Qoder` / `cosy-clienttype` / `cosy-version` 与不带结果一致
   （实测两种形态均 200）。桌面端头只对 `/sash/*` 运营面是必需的。
8. **对话面不返回结构化 `tool_calls`**。传 `tools` 后模型把调用写成普通文本
   （`"call\n{\"name\":…}"`），`finish_reason` 仍是 `stop`。网关不做文本→tool_calls
   启发式改写（见「国际版对话转发」）。

## 快速开始

### 1. 导入账号（两条路，按部署形态选）

Qoder 上游只认**纯 Bearer 的 `dt-` access token**，凭据本身可移植，因此有两条导入路径：

| | 方式一：读取本机客户端 | 方式二：手动粘贴 token |
|---|---|---|
| 适用 | 服务端与客户端同机 Windows | Linux 部署、跨机接入 |
| 用户手上要有 | 已登录的桌面客户端 | 从客户端取出的 `dt-` token 或凭据 JSON |
| realm 由谁定 | 后端按「扫到哪个客户端目录」定 | 用户在弹窗里显式选 |
| 验证 | 解密即验证（DPAPI 失败会报错） | 默认在线验证（`userinfo`） |

**方式一**：本机装有 Qoder 桌面客户端（国际版和/或国内版）且已登录。

- **面板**：凭据池页 → 「接入 Qoder」→ 显示双区域探测结果 → 「导入全部区域」
  →「启用并完成」。
- **API**（管理密钥鉴权）：

```powershell
POST /v1/qoder/local/import                  # 导入全部已登录区域（幂等）
POST /v1/qoder/local/import/cn               # 只导入国内版
POST /v1/qoder/local/import/intl             # 只导入国际版
GET  /v1/qoder/local/preview                 # 预检（不解密全文，只看装没装、登没登）
```

**方式二**：服务端不在 Windows 上、或要接入别处机器上的账号时，从客户端机器上取出
token 粘贴进来。DPAPI 密文换机解不开（见 `docs/01-architecture/known-limitations.md` F7），但
`dt-` token 本身不绑机器，所以这条路是真的可用——这与 ZCode 恰好相反
（它的 JWT 由「平台 + 家目录 + 用户名」派生，上游不发放可移植凭据，
所以 ZCode 没有粘贴入口）。

```powershell
POST /v1/qoder/manual/import
{
  "realm": "intl",                              # 必选：cn | intl
  "credential": "dt-0IUJEMYfFUFu9beAsx0cMaR9",  # 裸 token，或凭据 JSON 文本
  "label": "我的国际版账号",                     # 可选
  "verify": true                                # 可选，默认 true
}
```

`credential` 接受三种形态：裸 `dt-` token（`Bearer ` 前缀与首尾空白会被剥掉）、
`auth.v1.dat` 解密后的凭据 JSON、`deviceToken/poll` 的响应 JSON（字段名差异由
`crypto.normalizeAuth` 兼容）。

- **realm 必选，不能省略也不能靠猜**。国内版与国际版是两套完全独立的账号体系
  （uid 不同、域名不同），token 不能跨区使用；而国际版客户端的 `fastEndpoint`
  实测指向 `api6.qoder.com.cn`（一个 `.com.cn` 域名），按域名猜会把国际版
  误判成国内版。未指定时归 intl（`variant.qoderRealm` 的既有口径）。
- **默认在线验证**：用 `GET /api/v1/userinfo` 确认 token 有效并取回 uid / 昵称 /
  邮箱，同时作为账号默认标签。不验证就会把无效 token 静默入库，而它要到第一次
  领积分时才失败（30 天后才有人发现）。上游暂不可达时可传 `verify: false`
  跳过——与 WorkBuddy 的跨机粘贴同语义：导入后需自行确认。
- **幂等键与本机导入一致**（`realm + userId`）：同区域的同一账号换 token 只会
  更新凭据，不会产生重复记录（否则领取任务会对同一账号跑两遍）。
- **不擅自改启用状态**：更新既有账号时保留其 `enabled`——账号可能正被用户停用
  （例如不想再领积分），覆盖回去会让这个决定静默失效。新建时才默认启用。

错误语义：400 = 输入非法（空/非 JSON/数组/token 不是 `dt-` 前缀）或 token 无效
（含区域选错，文案会提示）；502 = 上游不可达或区域未开放此端点。

#### 怎么从客户端机器上取出 token

关键前提：**必须在能解开 DPAPI 的那台机器上、用当初登录 Qoder 的那个 Windows
账户操作**。把 `auth.v1.dat` 和 `Local State` 一起拷到别的机器是没用的——
DPAPI 密钥由 Windows 登录凭据派生，不由文件内容决定，换机器/换用户即
`CryptographicException`（实测，见 `docs/01-architecture/known-limitations.md` F7）。
下面这个脚本在目标机器上直接解出本机登录态并打印完整 token：

```powershell
node scripts/ops/export-qoder-token.js          # 两个区域都打印
node scripts/ops/export-qoder-token.js intl     # 只打印国际版
```

脚本只读、不写客户端文件、不发网络请求，自带全部解密逻辑（无需 RelayGate 仓库
其余部分，单文件拷过去即可）。输出形如：

```
=== 国际版（intl）===
账号: {"id":"019f0dea-…","name":"Lice","email":"werrice@outlook.com"}
token 有效期至: 2026-11-12T08:02:16Z
----- 下面这行整行复制，粘到另一台机器的「手动粘贴 token」里 -----
dt-VGtS2AKqeRIRhLN72mh4PvqN
```

把整行 `dt-…` 复制到本服务的「接入 Qoder → 手动粘贴 token」，区域选对（国内版 /
国际版账号体系独立，粘错区域会在验证阶段被 400 拒绝并提示），保持「导入时在线验证」
勾选——验证通过会顺带取回账号昵称作为标签。

> **安全**：token 等同账号密码。它只应进入你自己控制的管理面板，不要贴到聊天、
> 邮件、issue 或截图里。`dt-` token 的有效期约 30 天（见上面输出的 `有效期至`），
> 过期后在上游重新导出一次即可；`drt-` refreshToken 不会随 token 一起发放，
> 所以这条路径**没有自动续期**——到期需手动更新，面板「账号到期」列会显示剩余天数。

（含区域选错，文案会提示）；502 = 上游不可达或区域未开放此端点。

导入内容：`dt-` access token + `drt-` refresh token（列级 AES-256-GCM 加密入库）、
`user_id`、`user_name`、`user_email`、`expiresAt`、`qoder_realm`。

> 凭据解密链路：客户端 `auth.v1.dat` = `"v10" + nonce(12) + AES-256-GCM(ct+tag)`；
> 密钥在同目录 `Local State` 的 `os_crypt.encrypted_key`（base64，去掉 5 字节 `DPAPI`
> 前缀后经 Windows DPAPI `CryptUnprotectData` 解出 32 字节）。
> DPAPI 无 Node 原生绑定，通过 `powershell.exe` 调
> `[System.Security.Cryptography.ProtectedData]::Unprotect`，base64 **经 stdin 传**
> （命令行传参会被 PowerShell 当裸 token 解析，ParserError）。
> **仅在 Windows 本机可用**：服务端部署在 Linux 时凭据应先在 Windows 上导入再同步库。

### 2. 开启定时任务

```powershell
# .env
QODER_REWARDS_ENABLED=true
```

或热改：`POST /v1/qoder/settings {"enabled": true}`。

默认 **10:15** 本地时区。若部署机时区不是 UTC+8，调整 `hour`/`minute`
使执行时刻落在上游 UTC+8 10:00 刷新之后（早于刷新会拿到空列表，晚太多错过当日）。

### 3. 验证

```powershell
GET  /v1/qoder/status                        # 平台能力 + 任务状态 + 客户端探测 + 对话转发实况
GET  /v1/qoder/accounts                      # 账号列表（脱敏 + 奖励摘要）
GET  /v1/qoder/accounts/<id>/campaigns       # 活动列表
GET  /v1/qoder/accounts/<id>/quota           # 两段额度
POST /v1/qoder/accounts/<id>/claim           # 领取（body 可带 campaignId）
GET  /v1/qoder/accounts/<id>/models?prefer=cosy   # 模型目录（cosy|cache|auto）
POST /v1/qoder/run?claim=false               # 全账号跑一轮（只探测）

# 国际版对话转发（转发面 access key，仅通用密钥 platform=all）
POST /v1/qoder/chat/completions              # {"model":"qmodel","messages":[…],"stream":true}
GET  /v1/models?platform=qoder               # 发现可调用模型
```

命令行演练：

```powershell
node scripts/verify/test-qoder-integration.js       # 28 项真实上游 + 真实客户端集成测试
node src/test/qoder.test.js                  # 50 项单测（无网络）
```

结果在面板「任务日志」中查 `task=qoder-rewards`；通知走既有渠道
（事件：`qoder_reward_claimed` / `qoder_reward_failed` / `qoder_reward_empty` / `qoder_reward_already`）。

## 架构与文件

```
src/platform/variant.js        QODER 变体表（realms 域名/路径/能力位/时段）+ qoderChatRealms/qoderChatOk —— 单一事实源
src/qoder/
  crypto.js                    os_crypt v10 解密 + DPAPI（PowerShell stdin）
  local.js                     双区域客户端凭据扫描、探测、导入（幂等）
  client.js                    运营面 HTTP 通道（桌面端头 / 信封解析 / 区域不可用）
  rewards.js                   campaigns / claim / quota / probe（业务核心）
  catalog.js                   COSY 签名 + 自定义 Base64 + QMC 解密 + 目录归一
  chat.js                      国际版对话面（可调用模型清单 / SSE 透传 / usage 窥探）
src/jobs/qoder-rewards.js      每日 10:15 定时（错峰 / 幂等 / 任务日志 / 通知）
src/routes/qoder.js            /v1/qoder 管理端点 + /v1/qoder/chat/completions 转发
src/credentials/pool.js        editionOk：qoder 分池三重收口之一
src/middleware/model-access.js isQoderOnlyModel：密钥平台边界（三重收口之三）
src/test/qoder.test.js         单测（无网络、无真实客户端）
scripts/verify/test-qoder-integration.js  集成测试（真实上游 + 真实客户端）
```

### 与既有系统的关系

- **账号库共用** `accounts` 表，`edition='qoder'` 区分；新增列 `qoder_realm`
  （可空，旧账号零影响，`ensureSchema()` 条件 `ALTER TABLE` 迁移）。
- **转发池隔离**：`pool.editionOk` 是 qoder 分池的第一道闸——qoder 账号只在显式
  `edition:'qoder'` 时进池，未指定 edition 时显式排除（原因见「分池红线」）；
  `capability.checkin=false`，qoder **不进入** `checkin-all` 的平台枚举
  （积分领取走自有时段任务，不是「今日签到」语义）。
- **密钥边界**：`middleware/model-access.js` 的 `isQoderOnlyModel` 让 Qoder 模型
  只能由通用密钥调用；`auth/scope.js` 的 `modelResourcePath` 为它留了
  `model:qoder/*` 独立资源前缀。
- **模型发现**：`/v1/models` 增加 qoder 段（`owned_by:'qoder'`，仅在有启用的
  国际版账号时列出），并支持 `?platform=qoder` 过滤——此前显式 `?platform=`
  会被通用密钥的 `req.platform='all'` 静默覆盖，一并修复。
- **余额刷新**：`upstream/balance.js` 已分流——qoder 账号走 `refreshQoderBalance`。
- **前端**：`platformOf()` 新增 `'qoder'`；余额列对 qoder 账号显示 `quota.totalRemaining`
  并标注 `cr`；签到按钮对 qoder 隐藏；来源筛选器补齐 zcode/qoder（此前只特判 workbuddy，
  选「Trae」时列表与「全部」相同——一并修复）；新增「接入 Qoder」弹窗
  （`ImportQoderDialog.tsx`，双区域探测 + 就地启用）。
- **标定键**：`pricing-calib.calibKey` 为 qoder 独立前缀（`qoder:qfmodel`），
  避免与 Trae/WorkBuddy 的模型名归一到同一串。

### 计量口径隔离（关键约束，改代码前必读）

Qoder 的额度是**两段独立**的：`userQuota`（套餐内基础，300）+ `addOnQuota`（赠送/签到，
100，每日积分 landing 进这里）。单位都是 credit，但语义不同（addOn 由活动产生）。

**禁止把两段加总后写进积分口径**——这正是 ZCode 曾踩过的坑（token 数混进 credits，
面板「今日消耗」被抬高 4 个数量级）。当前实现约定：

| 位置 | Qoder 写入 | 积分消费方 |
|---|---|---|
| `accounts.balance` | 恒 `null` | pool / credit-alerts / 面板余额列 |
| `entitlement_snapshot.packs` | **不写** | `creditTotals` / `summarizeExpiry` / `summarizeFefo` / FEFO 排序 |
| `entitlementSnapshot.quota` | ✔ 写（base / addOn / totalRemaining 嵌套键） | 无积分消费方 |
| `credit_history` | **不写** | `/v1/admin/credit-history` 的 `totalUsed` |

前端展示：CredentialsPage 对 qoder 账号显示 `quota.totalRemaining` 并标注 `cr` 单位，
tooltip 明示「基础 X + 赠送 Y，两段隔离，不计入积分汇总」。

## 配置项

| env | 默认 | 说明 |
|---|---|---|
| `QODER_REWARDS_ENABLED` | `false` | 定时任务总开关（默认关，避免影响现有池） |
| `QODER_REWARD_HOUR` | `10` | 执行时刻（本地时区小时） |
| `QODER_REWARD_MINUTE` | `15` | 执行时刻（本地时区分钟） |
| `QODER_REWARD_SPREAD_MINUTES` | `10` | 多账号确定性错峰窗口（单账号无影响） |
| `QODER_REWARD_AUTO_CLAIM` | `true` | 关闭则只探测通知、不实际领取 |
| `QODER_TIMEOUT_MS` | `25000` | 运营面上游超时（对话面另有默认 600000，见 `chat.js`） |
| `QODER_CN_APP_DIR` / `QODER_INTL_APP_DIR` | — | 覆盖客户端目录（便携版/非默认安装） |
| `QODER_CHAT_REALMS` | `intl` | 允许对话转发的 realm 白名单（逗号分隔）。**改它有风险**：国内版 `/model/v1/*` 实测 503，放它进来只会拿到 503 |

时段/开关也可在 `.trae-api/qoder-settings.json` 热改（文件 > env > 默认）。

## 国际版对话转发（已启用，单账号）

### 端点与鉴权

```
POST /v1/qoder/chat/completions
Authorization: Bearer <访问密钥>        # 转发面 access key，不是 dt- token
Content-Type: application/json

{"model":"qmodel","messages":[{"role":"user","content":"hi"}],"stream":true}
```

- 密钥平台：**仅通用密钥（`platform=all`）**。trae / workbuddy 平台密钥一律 403
  （`middleware/model-access.js` 的 `isQoderOnlyModel` 分支）——Qoder 是独立账号池，
  不让平台密钥越界消耗它的积分。
- 与 `/v1/chat/completions` 共用同一限流中间件实例（同 key 同一额度池）。
- 模型列表可在 `/v1/models?platform=qoder` 发现（仅在有启用的国际版账号时列出）。

### 可调用模型（实测清单）

`src/qoder/chat.js` 的 `CALLABLE_INTL_MODELS`：

```
auto  ultimate  performance  qmodel  kmodel  gmodel  dmodel  mmodel
```

**`is_free=true` 不等于可调用**，这是本次接入最容易踩的坑：

| 模型 | 目录标识 | chat 端点实测 |
|---|---|---|
| `qfmodel`（Qwen3.8-Flash 限免） | `is_free=true, price_factor=0` | **400 `invalid_model_error`** |
| `efficient` | `price_factor=0.3` | **429 `provider_error`**（All backends failed） |
| `smodel` / `cmodel` / `qmodel_38max` / `qmodel_latest` / `kmodel_latest` / `gfmodel` / `dfmodel` / `fast` | — | 400 `invalid_model_error` |

网关在发请求前就按清单拒绝不可调用模型（400 + 明确文案），不会把上游 400 透传给客户端。
清单有时效性，上游随时可能增删；运维可用 `chat.refreshCallableModels(acct)` 重新探测。

### 三条必须知道的协议事实

1. **不需要运营面那三头**。`User-Agent: Qoder` / `cosy-clienttype` / `cosy-version`
   对对话面完全无影响（实测带与不带结果一致）；纯 `Authorization: Bearer` 即可。
   `cosy-machine*` 六头同运营面结论，一律不发。
2. **上游不返回结构化 `tool_calls`**。传 `tools` 后模型把调用写成普通文本
   （`"call\n{\"name\":…}"`），`finish_reason` 仍是 `stop`。网关**刻意不做**
   文本→tool_calls 的启发式改写——那是猜测，误判会让 agent 执行一个并未发生的调用。
   需要工具调用的客户端请用 Trae / WorkBuddy 池。
3. **`usage` 在 `[DONE]` 前一帧**，不是每帧都有（多数帧 `usage:null`）。
   含 `prompt_tokens_details` / `completion_tokens_details`（`reasoning_tokens`、
   `cached_tokens`），原样透传给 `usageToLogFields` 解析，计费日志能拿到缓存读 token。

### 为什么只开单账号

`pickChatAccount()` 只取一个 enabled 的国际版账号，刻意不做轮询/择优：
上游并发与风控阈值未验证，贸然轮询会把号打挂。sticky 会话会复用同一账号，
避免同一会话跨账号导致上下文丢失。

## 国内版对话面为何仍未启用

`gateway.qoder.com.cn/model/v1/*` 实测 **503**，必须走 COSY 老协议：

```
POST /algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
```

（RSA-1024 包裹 16 字节临时密钥 + MD5 签名 + 自定义 Base64 请求体），实现成本高且
同样未经多账号验证。COSY 的签名部分已在 `src/qoder/catalog.js`（`cosyHeaders` /
`qoderEncode`）落地并实测可拉到模型目录，将来启用时无需重写签名，只需补 SSE 对话帧解析。

COSY 实现的四个易错点（错一个就是 `{"code":"101","message":"Signature invalid"}`）：

| 项 | 正确值 | 易错值 |
|---|---|---|
| `cosyVersion` | `1.1.64` | `0.4.3`（桌面版版本号，不是协议版本） |
| `ideVersion` | `""` | 任意非空 |
| `version` | `"v1"` | 其它 |
| identity 键集 | 9 键：`name/aid/uid/yx_uid/organization_id/organization_name/user_type/security_oauth_token/refresh_token` | `machine*` 字段 |

另：请求必须带同款 body（`qoderEncode("{}")`）且用 `node:https` 的 `GET` + `req.write(body)`
——Node 的 `fetch` 不允许 GET 带 body，改 POST 会被上游拒（`Request method 'POST' not supported`）。

## 分池红线（改代码前必读）

`capability.chat=true` 是**平台级**开关，**不代表两个 realm 都能转发**。三重收口：

1. `variant.qoderChatRealms()` —— realm 白名单，默认只有 `intl`（可用
   `QODER_CHAT_REALMS` 覆盖，测试用）。
2. `pool.js` 的 `editionOk()` —— qoder 账号**只在显式 `edition:'qoder'` 时进池**；
   未指定 edition 时显式排除。原因：`routes/openai.js` 的 Trae 直连分支、
   `routes/anthropic.js`、`routes/responses.js` 都有不传 `edition` 的 `pool.run`
   调用（fallback 到 Trae 池），国内版 qoder 账号若被选进这些链路，上游必然 503，
   表现为「Trae 请求随机失败」。
3. `middleware/model-access.js` 的 `isQoderOnlyModel` —— 密钥平台边界，
   平台密钥调 Qoder 模型一律 403。

这三条各由单测守门（`关键红线：capability.chat=true 不等于两个 realm 都能转发`、
`关键红线：未指定 edition 时 qoder 绝不落入 Trae 默认池`、
`关键红线：Qoder 模型只能由通用密钥调用`）。

## 风险与边界

- **只自动领取本机已登录账号自己的活动奖励**，不做多账号批量刷活动——那属于风控对象。
- 上游对已领取活动幂等（`replayed:true`），重复请求不会重复发放，但**仍不应高频调用**。
  定时任务每日一轮 + 错峰，天然保守。
- 空活动列表分两种情况，代码分别计数并通知：`alreadyToday`（当日已领，正常）
  与 `emptyList`（上游无活动或桌面端头被过滤，需人工判断）。
- `realm` 是账号的持久属性，导入后不变。若同一区域换账号登录，重新导入会按
  `realm + userId` 更新既有记录而非新建。
- DPAPI 解密仅 Windows 可用；Linux 服务端需在 Windows 上导入后同步数据库文件。
- **国际版对话转发是单账号的**：`pickChatAccount` 不轮询、不择优。多账号共用同一
  上游的并发行为未验证，启用轮询前必须先用独立小号做压测。
- **工具调用不可用**：上游不返回结构化 `tool_calls`。agent 类客户端请走
  Trae / WorkBuddy 池，不要在 Qoder 端点上试工具调用。
- **转发面超时默认 600 秒**（`chat.js` 的 `DEFAULT_TIMEOUT_MS`），与运营面的
  `QODER_TIMEOUT_MS`（25 秒）是两套——推理模型首字可达数百毫秒，完整输出可到分钟级。
