# 渠道接入（面板入口）设计与扩展说明

> 记录 **m-40**：面板此前是「每加一个平台手写一个弹窗」，ZCode 的后端接口
> （`/v1/zcode/local/preview`、`/local/import`、`/rewards/*`、`/accounts/:id/balance`、
> `/accounts/:id/fingerprint/rotate`）全部就绪并已上线，**前端却连一个按钮都没有**：
> 账号根本接不进来，只能翻文档打 curl，而且没有任何地方提示过这件事。

## 它解决什么

一次可复现的实证：本机装了 ZCode 桌面客户端且已登录
（`C:\Users\bing\.zcode\v2\credentials.json` 存在、JWT 可解），
Qoder 双区域也都已登录，但**这些账号此前无法通过面板接入**。

现在的结构把「漏加入口」从**静默**变成**可见**：

| 层 | 单一事实源 | 作用 |
|---|---|---|
| 平台定义 | `src/platform/variant.js` 的 `VARIANTS` | 渠道身份、能力位、`note`、`onboarding`（声明有哪些接入方式） |
| 聚合端点 | `GET /v1/admin/channels`（`src/routes/admin-channels.js`） | 把能力位 + 真实账号计数 + **本机客户端实测**摊平给前端 |
| 前端注册表 | `web/src/shared/lib/channelIds.ts` + `channels.ts` | 只回答后端回答不了的问题：**哪条接入方式打开哪个向导** |
| 渲染 | `web/src/features/accounts/ChannelGrid.tsx` | 渠道卡片：状态徽标、计数、能力标签、逐条接入按钮 |

## 不变式（改动时不要破坏）

1. **每个渠道必须声明至少一条 `onboarding`。** 声明为空 = 该渠道的账号永远进不来。
2. **后端声明的每条 `onboarding[].kind` 必须在前端 `CHANNEL_ENTRY[id].wizards` 里有落点。**
   没有落点时卡片会显示「暂无接入向导」（降级可见，不是白屏），但这是缺陷不是设计。
3. **前后端渠道集合双向一致。**
4. 判定「已接入」用 `accounts.total > 0`，**不是** `enabled > 0`：
   WorkBuddy 导入后显式 `enabled=false`，按 `enabled` 判定会把刚导入完的渠道
   显示成「待接入」，与用户刚做完的操作直接矛盾。
5. 行内按钮（签到 / 领取）按**后端能力位**显示，不按平台名硬编码。

以上 1–3 与 5 都由 `src/test/channels.test.js` 钉住（会失败的断言，不是注释约定）。

## 新增一个渠道要改哪些地方

后端：

1. `src/platform/variant.js` 里加一项（`id` / `label` / `edition` / `capability` /
   `note` / `onboarding`，以及域名、路径、错误码、身份头）。
2. 平台自己的模块目录（如 `src/<platform>/local.js` 负责本机凭据读取）。
3. 平台自己的一组管理路由，挂到 `/v1/<platform>`（鉴权按路由注入 `authenticateAdmin`）。
4. 若新增了「本机客户端」接入方式，在 `src/routes/admin-channels.js` 的 `localProbe()`
   里补一个分支（返回 `{available, detail}`；`detail` 在不可用时要说明**装什么**）。
5. 若渠道有运营面（`capability.rewardClaim`），在 `jobsFor()` 里接上它的任务快照。

前端：

6. `web/src/shared/lib/channelIds.ts` 加 id。
7. `web/src/shared/lib/channels.ts` 的 `CHANNEL_ENTRY` 加上 `accent` 与
   `wizards`（覆盖后端声明的每一条 kind），向导种类加进 `WizardKind` 联合类型。
8. 写该渠道的接入弹窗，在 `CredentialsPage.tsx` 的 `openWizard()` 里接上分支。
9. `npm test` 会替你把 1–3 的一致性检查跑一遍。

## 设计取舍（为什么不是参考项目那样）

参考项目（`dsh-our-free-model`）的渠道页是「provider 卡片网格 + 通用 `ChannelCard`」，
其 provider 清单来自**前端静态导入**（`ofm-provider-list`）。这里只借了
「卡片网格 + 状态徽标 + 已接入/待接入筛选」的信息结构，没有照搬静态清单：

- 本仓库的 `variant.js` 已经是平台定义的正源，再在前端维护一份清单必然漂移；
- 参考项目的 provider 是同构的（都能用一个通用登录流程），而本仓库四个渠道的
  接入方式**不同构**（Trae 是 OAuth + 粘贴 JSON、WorkBuddy 是读本机文件 + 粘贴、
  ZCode 只能读本机文件、Qoder 是双区域读本机文件）。硬套一个通用卡片会得到
  一个「参数化到没人看得懂」的组件；
- 因此采用「后端声明能力位 + 本机实测可用性，前端按 id 注册向导」的形态：
  信息结构借参考项目，数据来源用本仓库已有的正源。

## 端点

```
GET /v1/admin/channels        # 管理鉴权
```

响应：

```jsonc
{
  "object": "channels",
  "data": [{
    "id": "zcode", "label": "ZCode", "note": "…",
    "capability": { "chat": false, "rewardClaim": true, "localImport": true, "…": "…" },
    "accounts": { "total": 1, "enabled": 1, "cooling": 0 },
    "onboarding": [{ "kind": "local", "label": "读取本机客户端",
                     "available": true, "detail": "C:\\Users\\…\\.zcode\\v2\\credentials.json" }],
    "jobs": { "enabled": false, "nextRunAt": null, "accounts": 1, "solver": { "…": "…" } }
  }],
  "summary": { "channels": 4, "connected": 1, "accounts": 1, "enabled": 1 }
}
```

- `onboarding[].detail` **不可用时必须给出可行动的原因**（缺哪个文件、要装什么客户端），
  不是空串、不是错误码。可用时给位置或已登录账号。
- Qoder 额外带 `windows` 与 `realms`（双区域各自 `installed` / `loggedIn` / `available` / `detail`）。
- `jobs` 里的 `localClient` 被**刻意去掉**：本机探测统一由 `onboarding` 给出，
  同一响应里出现两个可能不一致的结论比不提供更糟。
- `jobs` 为 `null` 表示该平台没有运营面定时任务（Trae / WorkBuddy）。

## 运营面面板

`capability.rewardClaim === true` 的渠道在卡片与凭据行内都有入口：

- **ZCode**（`ZcodeOps.tsx`）：探测可领套餐 / 领取（含逐套餐领取）/ token 额度 /
  设备指纹换发 / 定时任务开关与两个时段 / 验证码求解自检。
- **Qoder**（`QoderOps.tsx`）：活动列表 / 领取 / 两段额度 / 定时任务与时刻。

口径约束（违反会静默出错）：

- ZCode 额度单位是 **token**（单包 1e8），Qoder 是 **credit** 且分基础 + 赠送两段。
  两者都只做展示，**都不并入积分汇总**。
- 领取要现解验证码或走上游活动平台，故这些请求用 180s（ZCode）/ 120s（Qoder）超时，
  不能沿用默认 30s，否则正常请求会被误判成超时。
- ZCode `3012` 是真风控：后端会立即中止该账号且**不自动换指纹**；
  面板上的「换设备」是人工决策按钮，界面上已写明。
- Qoder 上游在身份头被过滤时**不报错但返回空列表**，界面把「空列表」与
  「今日已领」「真没活动」分开呈现。

## 已知边界

- `GET /v1/admin/channels` 每次调用都会做本机磁盘探测（Qoder 扫双区域应用目录、
  WorkBuddy 读 auth 文件、ZCode 判凭据文件存在）。都是本地读、无网络，但它是
  同步的请求路径代码；面板只在进入页面、手动「重新探测」与写操作后调用，
  60 秒的余额轮询**不会**带上它（见 `CredentialsPage.tsx#reloadAll` 的注释）。
- 前端注册表的一致性测试**提取源码字面量**（`channelIds.ts` 的 `CHANNEL_IDS` 数组、
  `channels.ts` 的 `wizards` 块）。重排缩进、把 wizards 拆成多行都不影响；
  但重命名这两个结构会让测试失去提取目标——届时断言会因「提取为空」失败，
  而不是静默通过。
