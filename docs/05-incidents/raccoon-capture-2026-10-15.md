# Raccoon（商汤小浣熊）抓包解包实测报告（2026-10-15）

> 本文是对**本机已安装**的官方桌面客户端（`C:\opt\workstations\agents\raccoon-ai`，
> v1.0.38）做「解包 + 运行时抓包 + 端到端复放」的一手结论。
> 方法与本仓库 Qoder / WorkBuddy 渠道完全一致（见
> `docs/02-technical/channels/qoder-integration-analysis.md`、`docs/02-technical/workbuddy-at-rest-crypto.md`）。
>
> 它**修正了** `docs/02-technical/channels/raccoon-integration.md` 里两条写于「本机没装客户端」时期的
> 过时论断，并定位 / 修复了一个此前无法被观察到的 P0 缺陷。

## 0. 方法与产物（可复现）

| 步骤 | 工具 / 脚本（全部已入库） | 产物 |
|---|---|---|
| 解包 app.asar | `scripts/inspect/parse-raccoon-asar.js`（零依赖，仿 qoder 版） | `logs/raccoon-extracted/raccoon-asar-{summary,files}.txt`（13216 个文件） |
| 抽取业务代码 | `scripts/inspect/extract-raccoon-asar.js --all` | `logs/raccoon-extracted/asar/build/`（57.5 MB，1765 文件） |
| 运行时抓包 | `scripts/probes/capture_raccoon.py`（mitmdump addon，12.2.3） | `logs/raccoon-capture.jsonl`（敏感头掩码） |
| 只读接口探测 | `scripts/probes/probe-raccoon-api.js` | `logs/raccoon-api-probe.json` |
| 网关端到端验证 | `scripts/verify/verify-raccoon-live.js`（走网关自己的模块打真上游） | 控制台（4/4 通过） |

凭据来源：客户端 **`~/.box-agent/config/auth.json` 明文 JSON**（见 §3），
含 access_token / refresh_token / office_identity。全程只对**该账号自己的数据**
做只读探测；写端点只复放了一次幂等的 `login/points/grant`（已领过，返回 `granted:false`）。

## 1. 「每日 300 积分」结论 —— 与旧文档一致，但证据从「转述」升级为「穷举 + 实测」

旧文档说「每日 300 没有端点，服务端自动发」。本次在**完整解包 + 全量端点穷举**
（1597 处 URL 拼接）后确认：

- `points/v1` 下**只有** `balance` 与 `bills` 两个路径，全仓没有任何
  `daily / checkin / sign_in / claim / receive / tasks / reward` 形态的发放端点
  （对 18 条候选路径逐一 GET 探测，全部 `404 page not found`）。
- 唯一能主动调的发放端点是**一次性**的 `POST /api/web/desktop/v1/login/points/grant`
  （每号一次，重复调返回 `granted:false`），与每日无关。
- 账单实证每日发放：

```
biz_type=daily_grant   +300   grant_at=2026-10-15T00:00  expire_at=2026-10-21T23:59
biz_type=daily_expire  -300   （2026-10-14 未用尽的部分整额清零）
```

**但旧文档漏掉了关键的一半**：每日 300 不是「永久有效」，而是 **grant→expire 约 7 天
窗口、未用尽即由 `daily_expire` 清零**。本机账号 10-14 的 300 分一分没花、整额作废。
所以「优化每日签到」在这个渠道的正确形态不是领取按钮，而是把它变成**可运营信息**：
今日还剩多少、最早何时作废、历史作废了多少 —— 新增只读端点
`GET /v1/raccoon/accounts/:id/daily-usage`（`credits.fetchDailyUsage` +
`product.summarizeDailyPoints` 纯函数）。

### 1.1 ⚠️ 规则修正（2026-10-16）：不是「固定 7 天」，而是「当天 24:00 清零，登录才延长」

本节是**本轮最重要的规则发现**，旧文档与本文初稿都漏了。客户端 i18n 原文
（`dailyGrantRule`，中/英/日三语逐字一致）：

> 「每日积分每天 00:00 发放，**默认当日 24:00 清零**，**当天登录后有效期延长至 7 天**。」

配套文案：账单里 `billDescription.notLoggedIn`＝「当日未登录」、
`sameDayEnd`＝「当日 24:00」。

**本机账单三日实证**（同一账号，唯一变量是「当天有没有开桌面端」）：

| 日期 | 当天是否开过桌面端 | 当日 `daily_grant` 的 `expire_at` | 有效期 | 结果 |
|---|---|---|---|---|
| 2026-10-14 | ❌ 没开 | 2026-10-14 23:59:59 | **1 天** | 次日整额 `daily_expire` 清零 300 |
| 2026-10-15 | ✅ 开了 | 2026-10-21 23:59:59 | **7 天** | 未作废 |
| 2026-10-16 | ✅ 开了（08:56 启动） | 2026-10-22 23:59:59 | **7 天** | 未作废 |

口径换算：官方「N 天」= 账单 `grant_at`→`expire_at` 的**日历差 + 1**（含发放当日）。
`10-16 → 10-22` 日历差 6，官方称「7 天」；当天清零日历差 0，官方称「1 天」。

**所以「优化每日签到」在这个渠道的正确形态是**：没有「领取」动作（`checkin=false`
成立），但存在一个**每天必须发生一次的等价动作**——「当天登录」。网关侧代打那一次
幂等请求，等价于「替用户当天开一次客户端」，把 300 分从「当天作废」变成 7 天窗口
（**不增加总量**，每天仍只发 300，只是避免浪费）。

实现：`src/jobs/raccoon-keepalive.js` + `credits.touchDailyKeepalive`，
默认关闭（`RACCOON_KEEPALIVE_ENABLED`），面板可开关 / 设时刻 / 立即执行，
并在 variant 里新增能力位 `dailyKeepalive: true`。

### 1.2 为什么保活必须「自校验」

「登录延长」的**载体验证尚未穷尽**：关联性确凿（开客户端的日子都是 7 天期），
但「单次请求能否独立触发延长」无法在同一天内反复验证（当日发放只更新一次）。
2026-10-16 实测：当天已延长后，再用任意业务请求或 grant 去打，`expire_at` 都不再变化
——这既不能证明也不能证伪载体，只能证明**幂等**。

因此实现不预设载体，而是**用结果自证**：打完 grant 再读当日账单，按
`validityDaysOf()` 判是否 > 1 天；不是则重试一次、仍不是则告警，**绝不谎报成功**。
无论上游把「登录」挂在哪个端点，任务都能如实报告。

## 2. P0：`X-Org-Code` 绝不能填 `"personal"`（此前整条转发链静默全挂）

这是本轮最有价值的发现，旧文档完全没有。

- 个人账号客户端 `auth.json` 里的 `office_identity` 字面值是 **`"personal"`**。
- 本仓库把它落进了 `accounts.raccoon_org` 列，并在 `product.headers()` 里
  `'X-Org-Code': credential.office_identity || ''` **原样透传**。
- 上游会把 `personal` 当成真实 org code 去查，回
  `400 {code:200022, message:"org_not_found_error"}`。实测影响面：

| 端点 | `X-Org-Code: ""` | `X-Org-Code: "personal"` |
|---|---|---|
| `points/v1/balance` | 200 | **400** |
| `llm/v2/model_catalog` | 200 | **400** |
| `desktop/v1/login/points/grant` | 200 | **400** |
| `llm/v2/chat/completions` | 200 | **400**（整条对话转发不可用） |
| `points/v1/bills` / `auth/v1/user_info` | 200 | 200（这两条不查 org） |

也就是说：**扫码登录成功后，只要客户端那边是个人账号（默认形态），网关的
余额查询、模型目录、登录奖励、对话转发全部 400**，而账单/用户信息恰好不查 org，
导致问题被「登录成功 + 用户信息能拉」掩盖，极难从现象上定位。

修复：新增 `product.orgCodeOf()`，把 `personal`（大小写/空白不敏感）归一为空串，
企业真码照常透传。判据**照抄客户端自己的实现**（asar 渲染层模块 79746 的
`createHeaders()`：`e && "personal" !== e && (c = e)`）。

旁证（客户端为何不会踩这个坑）：`user_info.office_identity` 对个人账号返回的是
**空串**，而落盘的 `auth.json.office_identity` 是 `"personal"` —— 两个来源语义不同，
`local.js` 导入时也用 `orgCodeOf` 归一，防止脏值在账号库里扩散。

## 3. 「本机读不到凭据」论断被推翻 → 新增本机导入（`localImport: true`）

旧文档开篇断言「本机没有官方桌面客户端可读凭据」。装上客户端后不成立：

- 客户端主进程 `boxAgentAuthFile.js` 把登录态**明文**写到
  `~/.box-agent/config/auth.json`（路径可被 `BOX_AGENT_CONFIG_DIR` 覆盖），
  字段 `{ access_token, refresh_token, office_identity }`，0600 + rename 原子写，
  **无任何加密**（与 ZCode 的 AES-256-GCM、Qoder 的 DPAPI 都不同）。
- 实测本账号 `refresh_token === access_token`（客户端就是这么落库的，不是读错）。
- 新增 `src/raccoon/local.js`（preview / import）、路由
  `GET/POST /v1/raccoon/local/*`，渠道卡片追加第二条 onboarding `'local'`，
  能力位 `localImport` 由 false 翻 true。导入复用 `auth.persistLogin`，
  与扫码两条入口产出同形状账号（label / userId / 幂等判据一致），
  且导入前校验凭据未过期。

## 4. 其它被实测修正的旧口径

| 项 | 旧文档 | 2026-10-15 实测 |
|---|---|---|
| access_token 寿命 | 约 **3 小时**（`exp-nbf=10805s`） | **30 天**（解码本机 JWT：`nbf=1792027241 exp=1794619246` = 2592005s） |
| 登录奖励判定 | 查最近 50 条 `bills` | 必须带 **`type=income`**；默认时间倒序的 50 条几乎全是对话消耗，早期奖励账单被挤出，会恒判 `claimed:false`（已修，按 income 翻页） |
| `X-Client-Platform/Version` | grant 必需 | 实测 platform/version 任意取值（含缺失）grant 都 200；不是必需，但保留无害且更像官方客户端 |
| 模型目录 | 6 模型（兜底表） | 远端实测 **chat 类 9 个**（含 3 个 `visible:false` 的内部 raccoon-* 模型，解析器正确过滤），6 个兜底仍全部命中 |
| 账单 `type` 参数 | 文档写 `type=all` | 实测枚举只有 `all / income / expense`，其它值 `100002 params_invalid_error`；不带 type 等同 all |
| 设备标识 | 「不生成，该头实践中不出现」 | 客户端确有 `desktop-device-identity.json`（randomUUID），但仅用于 mobile-relay/配对/skill 投稿，业务面不发；故本地导入仍**不**把它带进业务头 |

## 5. 验证

- 单测：`src/test/raccoon.test.js` 由 33 → **37** 项（orgCodeOf P0、每日看板、
  local 模块、HTTP 新端点、对话面 personal 归一），全绿。
- 全量：`npm test` = **764/764 通过**（基线 760 + 4 新增），0 失败。
- Lint：改动文件 `npx biome check` 0 问题；web `eslint` / `tsc -b` 0 错误。
- 真机：`node scripts/verify/verify-raccoon-live.js` 用网关自己的模块打真上游 ——
  旧头复现 `400 org_not_found_error`，新头余额 / 远端目录 / 登录奖励状态 /
  用户信息全 200；`fetchDailyUsage` 返回 dailyRemaining=294、expiredTotal=300、
  nextExpiry=2026-10-21。

## 6. 明确没做 / 不做的事

- **不做签到按钮**：穷举 + 实测确认无端点（§1）。每日维度做的是**保活**（§1.1）
  与**只读看板**，二者都如实命名，不冒充「签到」。
- **不做短信登录**：需要阿里云滑块（`SceneId=1pkmy0x3`），本期仍只走扫码 + 本机导入。
- **不发明设备指纹**：业务面上游不收 `X-Client-Device-ID`，不发。
- **不改 `clientVersion` 常量**（v1.0.35 vs 客户端 v1.0.38）：实测该头不参与任何校验，
  改它只是追版本号，不影响行为，留待下次随客户端升级一起更新。
- **保活的边界**：它只是「延长有效期」，**不产生任何额外积分**；且上游若把「登录」
  定义收紧（例如要求真实桌面进程心跳），自校验会发现并告警，不会静默假成功。
