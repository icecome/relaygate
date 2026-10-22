# Raccoon（商汤小浣熊）渠道接入说明

> 接入范围：**扫码登录 / 本机客户端导入 + 账号运营面（积分 / 一次性登录奖励 /
> 每日积分看板 / 模型目录）+ 对话转发**。
> 移植来源：参考项目 `dsh-our-free-model` 的 `vendor/channel-pack/src/raccoon*.ts`
> （共 8 文件，MIT License, Copyright (c) 2026 Ebony-Vinyl）。
>
> 📌 **2026-10-15 已对本机安装的官方客户端（v1.0.38）做解包 + 抓包 + 端到端复放，
> 结论见 [`docs/05-incidents/raccoon-capture-2026-10-15.md`](../../05-incidents/raccoon-capture-2026-10-15.md)。**
> 该报告修正了本文档两条写于「本机没装客户端」时期的过时论断：
>
> - ❌ 旧：「本机**没有**官方桌面客户端可读凭据」→ ✅ 现：客户端把凭据**明文**写在
>   `~/.box-agent/config/auth.json`，可直接导入（`localImport: true`）。
> - ⚠️ 新增 P0：**`X-Org-Code` 绝不能填 `"personal"`**（个人账号 `office_identity`
>   的字面值就是它），否则余额 / 模型目录 / 登录奖励 / **整条对话转发**全部
>   `400 org_not_found_error`。判据见 `product.orgCodeOf()`。
>
> 另：access_token 实测寿命 **30 天**（不是本文早期写的 3 小时）；
> 「每日 300 没有端点」这一条经**全量端点穷举**再次确认成立，且其**未用尽会作废**
> 才是该渠道每日维度真正的优化点（新增只读 `/daily-usage`）。
>
> 官方登录靠 `office-raccoon://auth/callback` 自定义协议回调，而网关是服务端进程，
> **收不到该回调**；`/code/authorize` 页面的回调地址又是**写死的**，改不成 localhost。
> 故扫码仍只能由管理面板承载：后端生成 code + 面板渲染二维码 + 用户微信扫码 + 面板轮询。

## 它解决什么

Raccoon（`xiaohuanxiong.com`）是第五个渠道。它的三个特征是别的渠道都没有的：

1. **模型目录是远端动态下发的**，且每条带**计费倍率**与限免状态（`billing_effective_multiplier`
   / `billing_status`）—— 所以模型列表要显示 `GLM-5-3 · x0.75`、`Kimi-K3 · x1` 这种形态。
2. **每日 300 积分没有端点**（服务端按日自动发 `daily_grant`）。能领的只有一次性的
   「桌面端登录奖励」。**不要做签到按钮** —— 见下。
3. **对话面是标准 OpenAI 兼容 + 标准 SSE**（`chat.completion.chunk` + `data: [DONE]`，
   无加密、无信封、无格式转换），是五个渠道里成本最低的一条转发链路。

## 上游链路（实证）

```
POST {base}/api/web/auth/v1/login_with_qrcode_code   {"qrcode_code"}   ← 轮询扫码状态
POST {base}/api/web/auth/v1/refresh                  {"refresh_token"} ← 续期
GET  {base}/api/web/auth/v1/user_info                ← 用户信息（昵称/手机号/组织码）
GET  {base}/api/web/points/v1/balance                ← 积分（available_points 是核心字段）
GET  {base}/api/web/points/v1/bills?paging.limit=50&paging.offset=0   ← 账单（判登录奖励是否已领）
POST {base}/api/web/desktop/v1/login/points/grant    无 body            ← 一次性登录奖励
GET  {base}/api/web/llm/v2/model_catalog             ← 模型目录
POST {base}/api/web/llm/v2/chat/completions          ← 对话（OpenAI 兼容 + SSE）
GET  {base}/login/mp?code=<32hex>&appname=…          ← 二维码承载的**公开网页**（非 API）
```

`{base}` = `https://xiaohuanxiong.com`；域名与路径定义在 `src/platform/variant.js`
的 `[RACCOON]`（单一事实源），模块内不重复硬编码。

业务码：`100003` 手机号未加密、`100006` 滑块校验失败、`200003` refresh 失效（需重新登录）、
`200035` 授权码失效。

## 三个必须记住的坑（原文照搬，改代码前先读）

1. **`qrcode_code` 由客户端本地生成**（`randomBytes(16).toString('hex')`，32 位小写 hex）。
   参考项目实测「**任意自造 code 都被接受**并进入 `pending`」，这正是绕开自定义协议回调的办法。
2. **手机号必须 AES-128-CFB 加密**（密钥 `senseraccoon2023`，16 字节 ⇒ **必须写
   `aes-128-cfb`**，写 `aes-256-cfb` 会因密钥长度不足抛错），输出
   `Base64(iv ‖ ciphertext)`；否则 `send_sms` 回 `100003`。本实现只走扫码路径，
   短信路径**未提供**（它还需要阿里云滑块的 `captcha_param`，见「已知边界」）。
3. **每日 300 积分没有端点**。做成签到按钮必然失败，故
   `capability.checkin = false`，面板也不显示签到按钮。

## 登录时序

```
面板                    网关                          上游
 │ POST /v1/raccoon/login/session
 │──────────────────────▶ 生成 code(32hex) + 会话(内存, 5min)
 │◀── {sessionId, qrUrl, qr:{size,dim,margin,path}} ─┐
 │  渲染 <svg viewBox="0 0 dim dim"><path d={path}/>  │  ← 二维码由**后端零依赖编码器**产出
 │  微信扫码 → 在微信内授权
 │ GET /v1/raccoon/login/session/:id  （每 2 秒）
 │──────────────────────▶ POST login_with_qrcode_code
 │                       ◀── {status: pending|logging|canceled|success}
 │◀── {status} ──────────────────────────────────────┘
 │                       success → 拉 user_info → 落库 → 自动领一次登录奖励
```

- 会话是**进程内内存态**，刻意不落盘：含一次性票据、生命周期只有 5 分钟、
  重启后未完成的登录本就应作废。
- **同一会话的轮询串行化**：面板可能开两个标签页，2 秒一次的并发轮询会让同一个 code
  被查两次，且可能把「已成功」读成「还在轮询」（表现为扫码后二维码不变）。
- `canceled` 时换一个**新 code** 并重发二维码，否则用户会卡在一个永远不成功的码上。
- 任何异常/未知状态一律降级为 `pending`：轮询循环不该因一次抖动中断，
  而误判成 success 会拿到空 token 卡死、误判成 canceled 会无故刷新用户正在扫的码。

## 二维码为什么由后端生成

二维码内容是 `https://xiaohuanxiong.com/login/mp?code=<32hex>&appname=…`，含
**一次性登录票据**。

- **不能**交给第三方二维码图片服务生成 —— 那等于把票据送出去；
- **不能**用 `<img src=…>` 从后端拉 —— `<img>` 带不了管理密钥，只能把密钥塞进 URL；
- 故后端用自研零依赖编码器输出 **SVG 的 `path` 属性**，前端只渲染一个属性字符串，
  既不出网，也不需要 `dangerouslyInnerHTML`（无注入面）。

编码器在 `src/lib/qr.js`：byte 模式、纠错等级 M、版本 1–10（上限 213 字节），
超出容量**抛错**而不是静默产出扫不出来的坏码。它与参考实现
**逐位一致**（315 组输入对拍 + 29 组黄金哈希，见 `src/test/qr.test.js`）。

## 计量口径（本仓库的硬约束）

Raccoon 的积分单位是 **credit**（与 Trae/WorkBuddy 同口径），因此：

| 位置 | Raccoon 写入 | 说明 |
|---|---|---|
| `accounts.balance` | ✔ `available_points` | 面板余额列读它，口径正确 |
| `entitlement_snapshot.raccoonPoints` | ✔ 分池明细 + 时间戳 | **隔离键**，无任何积分消费方 |
| `entitlement_snapshot.packs` | **不写** | 余额 API 不给每个包的到期时间，写进去会污染 FEFO 排序与「3 日内到期积分」 |
| `credit_history` | **不写** | 尚未接入差分消耗统计 |

（ZCode 是反方向的坑：它的单位是 token，绝不能进积分口径。）

## 对话面

```
POST /v1/raccoon/chat/completions     # 转发面鉴权（访问密钥 + 限流）
```

- 模型走**独立端点**而不是并入 `/v1/chat/completions`：Raccoon 是独立账号池，
  **不进 Trae 转发池**（见下）。
- 模型边界：Raccoon 模型（`sn-` 前缀）**只有通用密钥（platform=all）可调**，
  trae/workbuddy 平台密钥一律 403。这条必须在 `middleware/model-access.js` 里
  显式收口 —— 否则「非 WorkBuddy 独有模型就放行」的 Trae 分支会把它当 Trae 模型
  放行，等于让平台密钥越界消耗 Raccoon 积分。
- `tools` **逐字透传**（留在请求体顶层）：参考项目里 Qoder 与 TRAE 都因漏发而让
  模型在正文里臆造 XML 工具调用、harness 认不出 → 任务终止。
- 思考档位：唯一有效的载波是 **`extra_body.thinking = {type:'enabled'|'disabled'}`**
  （provider 级方言，与模型无关）。**无效**写法（都实测过）：`extra_body.enable_thinking`、
  双层 `extra_body.extra_body.*`、把 `thinking` 放**顶层**、`reasoning_effort`
  （服务端接受该字段但**无任何可观测效果**）。
  本实现只在调用方**明确表达意图**时翻译：`reasoning_effort: 'none'` 或
  `thinking:{type:'disabled'}` → `disabled`；其余明确档位 → `enabled`；不说 → 一个字节都不改。

## 转发池隔离（容易踩的一处）

`pool.editionOk` 的「未指定目标平台」分支决定了 `routes/openai` / `anthropic` /
`responses` 那些**不传 edition**的调用会取哪些账号。它此前是
「`canChat` 为真且非 workbuddy」并**逐个排除 qoder** —— 那意味着每接入一个
`chat=true` 的新平台都会被静默放进 Trae 默认池，Trae 请求会拿着别家 token 打别家
上游。Raccoon 正是下一个。

现改为「归一化后属于 Trae 平台」：

```js
return variant.variantOf(edition).id === variant.TRAE;
```

⚠️ 刻意**不用** `isTrae(edition)`：它是显式白名单（trae/cn/sg/us/manual），
对**空 edition 与未知 edition 返回 false**，而默认池历来把这类历史账号视为 Trae 系
并放行。用 `isTrae` 会把它们静默踢出池，表现为整池 `No account available in pool`
（实测踩到，4 个 pool 用例变红）。

## 续期

`access_token` 是 JWT。寿命**实测为 30 天**（2026-10-15 解码本机客户端凭据：
`nbf=1792027241 exp=1794619246`，即 2592005s = 720.0 小时）。
本文早期写的「约 3 小时（`exp-nbf=10805s`）」来自参考项目样本，已不适用 ——
它只影响「多久续一次」的紧迫性，不影响正确性（续期窗口仍是提前 300s）。
有 `refresh_token` 与 `POST /api/web/auth/v1/refresh`。

- 过期时刻取值：`expires_at` → **回退 JWT 的 `exp`**。回退是必需的：`expires_at` 是
  可选字段，只读它会让过期判定恒为 false，续期永不触发（静默失效）。
- `refresh` 返回可能**只带新的 access_token**（不带新 refresh_token），此时必须
  **保留旧值**，否则续期一次就把账号变成不可续期。
- `401` 或 `100003`/`200003` 表示 refresh_token 已失效 → 提示重新扫码登录，不重试。
- 定时保活按**新增的 `tokenRefresh` 能力位**筛账号（此前复用 `oauthLogin`，
  对 Raccoon 不成立：它不是 OAuth 换票但必须续期）。
- ⚠️ 个别账号会出现 **`refresh_token` 与 `access_token` 完全同值**（本机客户端
  就是这么落库的，不是读错），此时续期照常用它去 POST `/refresh` 即可。

## 已知边界

- **短信登录未提供**：`send_sms` 需要阿里云滑块的 `captcha_param`
  （`SceneId=1pkmy0x3`、`prefix=hk1r5l`），那是另一套验证码基础设施。
  扫码路径不需要它，故本期只做扫码。要加短信需先解决滑块。
- **图片不做缩放**：上游对**请求体字节**卡 10MB。参考项目有一套按字节目标缩放的链路
  （640k 像素 / 512KB 每张）；本实现原图直发，超限时上游回 413，错误如实透传。
- **不做多账号轮询**：本期单账号（与 Qoder 同策略）——上游并发与限额阈值未验证。
- **`device_id` 不生成**：参考实现全链路只读不写 `device_id`（`X-Client-Device-ID`
  实践中不出现），我们没有它的生成规则，宁可不发也不发明一个假设备号。
- **模型目录远端解析的字段名未在本仓库实测**（`name` 作 id、`visible` 过滤、
  `billing_*` 倍率、`params.context_window` 等均照抄参考实现）。
  **2026-10-15 已用真实登录态实测远端路径**（`source: 'remote'`，chat 类 9 条，
  其中 3 条 `visible:false` 的内部 `raccoon-*` 模型被正确过滤），
  故「未经真实请求验证」这条边界已解除；失败时仍回退兜底表（6 个模型，
  带实测窗口与上限）并在 `source` 里如实标注 `fallback`，面板据此提示
  「倍率可能不是最新」。

## 文件

```
src/platform/variant.js     [RACCOON] 变体（域名/路径/身份/业务码/能力位/onboarding）—— 单一事实源
src/raccoon/product.js      纯函数与常量（手机号加密、JWT 过期、请求头与 orgCodeOf、展示名、目录解析、每日看板聚合）
src/raccoon/client.js       HTTP 通道（信封归一化 / 解包 / 账号→凭据映射）
src/raccoon/auth.js         扫码登录会话（进程内）/ 续期 / 用户信息 / 模型目录
src/raccoon/credits.js      积分余额 / 一次性登录奖励（income 账单判定）/ 每日积分看板
src/raccoon/local.js        本机客户端凭据导入（明文 auth.json，preview / import）
src/raccoon/chat.js         OpenAI 兼容直通（tools 顶层透传 / extra_body.thinking）
src/lib/qr.js               零依赖二维码编码器（移植，逐位对拍）
src/routes/raccoon.js       /v1/raccoon 运营面（含 /local/*、/daily-usage）+ 对话转发
src/test/raccoon.test.js    37 项（含 orgCodeOf P0 回归、每日看板黄金样本、local 模块）
src/test/qr.test.js         38 项（二维码保真与结构）
web/.../ImportRaccoonDialog.tsx   面板承载的扫码登录 / 本机导入 / 账号运营 / 每日看板
docs/05-incidents/raccoon-capture-2026-10-15.md  本机客户端解包 + 抓包实测报告（修正本文的过时论断）
scripts/inspect/parse-raccoon-asar.js       asar 头解析（零依赖，仿 qoder 版）
scripts/inspect/extract-raccoon-asar.js     asar 按前缀抽取
scripts/probes/probe-raccoon-api.js        只读接口探测（签到端点穷举）
scripts/verify/verify-raccoon-live.js      网关模块 → 真上游端到端验证
scripts/probes/capture_raccoon.py          mitmproxy 抓包 addon
```
