# Qoder 接入分析与实施方案

> ⚠️ **本文档已被 [qoder-integration-analysis-v2.md](qoder-integration-analysis-v2.md) 取代，请勿据此实施。**
>
> 本文基于对客户端 asar 的静态分析，其中两个关键结论在结合开源逆向项目与本机实测后**被证伪**：
> - 「Qoder 无法像 ZCode 那样读文件拿到凭据」→ **错**，`auth.v1.dat` 是 Chromium os_crypt v10，本机已成功解出真 token
> - 「积分端点未实证，必须抓包」→ **已实证**，`/sash/api/v1/me/campaigns` 直接返回每日 100 Credits 活动原文
>
> 保留本文仅作为「如何从零分析一个未知客户端」的方法留痕（asar 解析脚本仍有效）。

---

## （以下为 v1 原文，结论已过时）

> 结论先行：**Qoder 可以按 ZCode 的先例接入「账号运营面」**（每日 100 积分自动领取 + 额度查询 + 限免模型清单），
> **但本期不建议接入「对话转发面」**——上游 chat 通道与 RelayGate 现有的 Trae/WorkBuddy 协议不同形，
> 且 Qoder 的客户端身份校验比 ZCode 更严（见「风险」节）。

---

## 1. Qoder 是什么（实证）

`C:\opt\workstations\agents\Qoder` 是阿里巴巴的 **Qoder 桌面客户端**（Electron，非 IDE 插件版）。
从 `resources/app.asar` 的 `package.json` 与 main bundle 实证：

| 项 | 值 | 来源 |
|---|---|---|
| 产品名 / 版本 | `qoder` **0.4.4**（Agent workbench） | asar `package.json` |
| 客户端形态 | Electron 主进程 + React 渲染进程，`out/main/index.js` 为入口 | asar 头解析 |
| 账号体系 | 阿里云账号（`support@qoder.com`），登录态写 `~/.qoder/.qoder-app-status.json` | 本机实证 |
| Agent 运行时 | 内置 `qodercli`（`~/.qoder/bin/`），协议族 `runtime:qoder` | main bundle `pOt()` |
| 模型供给 | `auto` + 目录由服务端下发（`~/.qoder/.models/<uid>/catalog-v6`） | 本机实证 |
| CN / 国际双线 | `qoder.com.cn`（CN）、`qoder.com`（国际）；域名映射两个固定 app id | main bundle `DVt()` |

本机用户 uid：`019f0dea-ce95-75ac-8e60-b5e973f3ed4f`（Lice / werrice@outlook.com）。

### 上游域名（本机 `.cache/endpoint-cache.json` 实证，prod）

```
inference（模型推理）     https://api3.qoder.sh
securityInference        https://api2.qoder.sh
openapi（开放 API）       https://openapi.qoder.sh
center（账号/权益中心）   https://center.qoder.sh
```

域名下发链路（可复用，避免硬编码）：`POST /algo/api/v2/service/region/endpoints`
（超时 15s；另有 `GET /algo/api/v1/version`，超时 5s）。请求头带
`X-Qoder-Remote-Api-Version: 2`。**支持自建接入域名**（企业 VPC 场景），
域名 → app id 的映射函数 `DVt()` 在 main bundle 有完整实现可对照。

### 凭据存储（关键约束）

Qoder **不用 Trae 的 `storage.json`，也不用 ZCode 的 `~/.zcode/v2/credentials.json`**。
本机 `~/.qoder/.auth/` 下只有 `machine_id` 与一个 0 字节的 `.credential-transaction` 锁文件，
真实 token 由 Electron `safeStorage`（DPAPI）加密后落在别处，**解密依赖本机用户上下文**。

**结论：Qoder 无法像 ZCode 那样「读文件即拿到 JWT」。**
可行路径只有两条：

| 路径 | 做法 | 评价 |
|---|---|---|
| A. 登录态复用 | 读 `~/.qoder/.qoder-app-status.json` 拿 uid/email，token 走客户端自身的 auth runtime | 只能证明「已登录」，拿不到可外发的 token |
| B. 手动粘贴 token | 用户在 Qoder 客户端内导出/复制 token，粘贴进面板导入 | **推荐**：与 RelayGate 既有的 Trae「凭据导入」完全同构 |

---

## 2. 三个需求的落地形态

### 2.1 每日 100 积分（有效期 30 日）

属于**签到/日活类运营活动**，与 WorkBuddy 成长中心、Trae 每日签到同类。
需要先抓一次真实响应确认端点与业务码——main bundle 中**未找到** checkin/sign-in 路径常量
（不同于 ZCode 把 `billingPreview/claim/balance` 明文写在 `variant.paths`），
Qoder 的权益端点大概率由 `center.qoder.sh` 动态下发或藏在 agent SDK 内。

因此实施顺序必须是：**先抓包，再写码**。

```
1. Qoder 客户端登录状态下，打开积分/签到页面
2. F12 → Network，筛选 center.qoder.sh
3. 找到形如 POST .../checkin 或 .../daily 的请求，记录：
   - URL / method / request body / response body
   - 全部请求头（Authorization 形态、X-* 头）
4. 把「已领取」的业务码与文案记下来（对应 ZCode 的 1003 alreadyClaimed）
```

抓到后即可套 ZCode 模板：`platform/variant.js` 加 `QODER` 变体 →
`src/qoder/rewards.js`（status/claim/balance）→ `src/jobs/qoder-rewards.js`（每日 10:00 后）→
`src/routes/qoder.js`（`/v1/qoder/*`）。

> 用户描述的「每日 10 点后可领 100 积分」正好对应 ZCode 的 `rewardClaimHours` 机制，
> 定时任务应配 **hour=10, minute=0**，并把有效期 30 日写进 `entitlement_snapshot.packs`
> 的 `expireTime`（`credentials/credits.js` 的 `summarizeFefo` 会自动做临期优先）。

### 2.2 Qwen3.8-Flash 限免

「限免」是**模型目录属性**，不是独立接口。Qoder 的模型目录由服务端下发到
`~/.qoder/.models/<uid>/catalog-v6`（本机该文件 92KB，为编码后的 catalog）。

接入方式：在 `models/catalog.js` 旁增加一个 Qoder catalog 适配层，把限免模型标记为
`rate: 0`（或 `discounted: true`，与 Trae 既有的 `parseContactRate` 语义一致），
这样面板的「模型列表」能显示「限免」徽标，`pool` 也不会把它计入成本档。

若 catalog-v6 的解码成本过高，退而求其次的方案是：**运营面只做额度查询 + 手动维护一份限免模型清单**
（写在 `variant.paths` 旁的常量表），把「目录自动同步」列为二期。

### 2.3 对话转发（本期不做，但要在架构上留位）

Qoder 的推理走 `api3.qoder.sh`，客户端身份头在 main bundle 的 `ide()` 函数有完整实现：

```
X-Request-Id / X-IDE-Platform / X-Version / X-Machine-OS / Cosy-ClientType / Cosy-Business-Product
```

**为什么不建议本期做转发**：

1. RelayGate 的 `transform/` 是围绕 Trae 的 `llm_utils_chat` + WorkBuddy 的
   `/v2/chat/completions` 建的，Qoder 的请求/响应结构尚未实证；
2. `Cosy-*` 头是阿里内部风控体系，写错的行为未知（可能静默失败，可能封号）；
3. ZCode 的教训：`capability.chat=false` 是**有意识的边界**，不是遗漏。
   它的 messages 通道至今未启用，注释明确写了「未充分验证前不宜并入转发池」。

正确做法与 ZCode 一致：`variant.paths` 预留字段，`capability.chat=false`，
等有独立小号验证完头形态再开。

---

## 3. 与既有架构的对接点

新增 `edition='qoder'`，全部按能力位分流，**零影响现有 Trae/WorkBuddy/ZCode**：

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/platform/variant.js` | 加 `QODER` 常量 + `VARIANTS[QODER]`（域名/路径/业务码/能力位） | 低（纯增量） |
| `src/credentials/db.js` | 无需加列——复用 `token_enc` / `balance` / `entitlement_snapshot` | 无 |
| `src/credentials/store.js` | `PATCH_COLUMNS` 无需改 | 无 |
| `src/credentials/pool.js` | 无需改——`capability.chat=false` 已让 qoder 不可能被选中 | 无 |
| `src/upstream/checkin-all.js` | 无需改——已按 `variant.can(edition,'checkin')` 自动纳入 | 无 |
| `src/upstream/balance.js` | 加一个 `refreshQoderBalance` 分支（与 wb/zcode 并列） | 低 |
| `src/upstream/checkin.js` | 若 Qoder 签到与 Trae 不同形，新建 `qoder-checkin.js` | 中 |
| `src/jobs/scheduler.js` | **无需改**——`jobs/qoder-rewards.js` 自管时段（与 zcode-rewards 同模式，`scheduler.js:635` 有注释说明为何不在此排程） | 无 |
| `src/index.js` | `app.use('/v1/qoder', qoder)` 挂载 | 低 |
| `web/src/app/nav.ts` + CredentialsPage | 加入口与账号页签 | 中（前端工作量） |

### 好消息：签到链已经是能力位驱动，Qoder 可零改接入

`src/upstream/checkin-all.js` 是本仓最值得复用的资产——它不是硬编码平台名单，而是：

```js
const accounts = store.list().filter((a) => a.enabled && variant.can(a.edition, 'checkin'));
```

也就是说，只要在 `variant.js` 里给 `QODER` 打开 `capability.checkin = true`，
每日签到批处理**自动**把 Qoder 账号纳入，无需改 `checkin-all.js` 本身
（只需在其中注册 Qoder 的 checkin 实现，与 Trae/WorkBuddy 并列）。

`upstream/balance.js` 同样是分流式（`refreshWorkbuddyBalance` / `refreshZcodeBalance` 并列），
加一个 `refreshQoderBalance` 分支即可，存量平台零影响。

### 必须显式排查的硬编码（新增平台的经典漏改点）

`variant.js` 的注释点名过这个问题：**「能力有无靠调用方自行比较 `edition === 'workbuddy'`（全库 40 余处）」**。
实测当前 `src/` 下有 153 处 edition 字面量。虽然签到/余额已收敛到能力位，但下列位置仍是字面量比较，
加 Qoder 时需逐个确认语义是「显式排除」还是「漏改」：

| 文件 | 现状 | 需要的动作 |
|---|---|---|
| `src/credentials/pool.js:469,493` | `edition?: 'trae'\|'workbuddy'` | 确认 qoder 不会被选中（靠 `canChat=false`） |
| `src/model-router/store.js:85,192` | `builtin` 只认 trae/workbuddy | 无需改（qoder 不走 model-router） |
| `src/model-router/dispatch.js:292,309` | `provider.builtin === 'workbuddy'` | 无需改 |
| `src/models/pricing-calib.js:62` | `p==='workbuddy'\|\|p==='wb' ? 'wb' : 'trae'` | **需加 qoder 分支**，否则费率被误归 trae |
| `src/jobs/growth-auto.js:214`、`growth-progress.js:77,88` | `a.edition === 'workbuddy'` | 无需改（WorkBuddy 专属活动） |
| `src/workbuddy/chat.js:158` | 同上 | 无需改 |
| `src/routes/models.js:119` | `a.edition === 'workbuddy'` 判 wb 可用性 | 如需暴露 qoder 模型则加分支 |
| `src/upstream/trae-usage.js:270` | `variant.isTrae(a.edition)` 显式白名单 | 无需改 |
| `web/src/features/accounts/CredentialsPage.tsx:523` | `platformOf(a) !== 'zcode'` | **需加 qoder**（否则 qoder 账号显示错误的操作按钮） |

其余按 `variant.can(edition, '<capability>')` 分流的位置无需改动。

---

## 4. 建议分期

| 期 | 内容 | 前置 |
|---|---|---|
| **P0** | 抓包：拿到积分签到/查询的真实端点、请求头、业务码 | Qoder 客户端 + 登录态 |
| **P1** | 运营面：凭据导入（手动粘贴 token）+ 额度查询 + 每日 10:00 自动领积分 | P0 |
| **P2** | 限免模型清单进模型目录（`rate: 0` 标记）+ 面板展示 | P1 |
| **P3** | 转发面（独立小号验证头形态后才做） | P1 + 小号 |

P1 的代码量约 600–800 行（对照 `src/zcode/` 的 6 个文件 + `src/jobs/zcode-rewards.js` +
`src/routes/zcode.js`），加单测约 150 行。**这是本仓已验证过的成熟路径，不是新探索。**

---

## 5. 风险

1. **凭据拿不到是最大阻塞**。ZCode 能自动导入是因为它把 JWT 明文（自派生密钥 AES-GCM）
   落在 `~/.zcode/`；Qoder 用 DPAPI，跨用户/跨机器不可读。若抓包发现 token 也不便导出，
   P1 只能做「面板手动粘贴」，自动化程度打折。
2. **积分端点未实证**。main bundle 无明文路径，必须抓包；若上游对非官方客户端拒绝
   （类似 ZCode 的 3012），需要按设备指纹补齐（`zcode/fingerprint.js` 那套 SKU 可直接改造）。
3. **30 日有效期的语义**要确认是「领取后 30 日」还是「固定月底过期」——两者对
   `summarizeFefo` 的排序影响不同。
4. **限免模型的计量口径**：若 Qwen3.8-Flash 限免期间不计费，`token-credit-metering` 的
   消耗统计要能识别并归零，否则面板「今日消耗」会虚高。

---

## 附：本次分析的产出物

- `scripts/inspect/parse-qoder-asar.js` — 解析 Qoder `app.asar` 头（不依赖 `@electron/asar`，离线可用）
- `scripts/inspect/extract-qoder-asar.js` — 抽取 asar 内指定文件
- `scripts/inspect/extract-qoder-code.js` — 抽取 `out/` 下全部 JS/JSON 供检索（用完已清理 61.5MB）
- `scripts/inspect/list-qoder-main.js` — 列出主进程文件与 renderer 关键词命中
- `logs/qoder-asar-summary.txt` / `qoder-asar-files.txt` / `qoder-main-files.txt` — 清单留痕
