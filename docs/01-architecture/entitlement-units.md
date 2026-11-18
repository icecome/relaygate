# 额度口径与保活模式（界面结论的唯一来源）

> 2026-11-17。回答两个被反复误读的问题：各平台的额度到底用什么计量；某个平台的账号到底保不保活。
> 适用读者：改面板文案的人、加新渠道的人、排查「面板数字对不上」的人。
> 相关实现：`web/src/shared/lib/entitlement.ts`、`web/src/shared/lib/overview-detail.ts`、
> `src/platform/variant.js`、`src/jobs/scheduler.js`。

---

## 1. 额度口径：五个平台，四种口径，其中三种都是积分

上游各平台返回的额度字段互不兼容，后端因此用四个**隔离键**分别落库。口径与落点：

| 平台 | 隔离键 | 内部口径键 | 上游实际单位 | 语义 |
|---|---|---|---|---|
| Trae | `entitlement_snapshot.packs` | `credit` | 积分（credit，量级 1e3） | 可累积、逐包有到期日 |
| WorkBuddy | `entitlement_snapshot.packs` | `credit` | 积分（同上，同一单位） | 可累积、逐包有到期日 |
| ZCode | `tokenBuckets` / `tokenRemaining` | `token` | Token（量级 1e8） | 与积分不同维，永不与积分相加 |
| Qoder | `entitlement_snapshot.quota` | `quota` | 积分（`userQuota` + `addOnQuota`，上游叫 Credits） | 分基础 / 赠送两段，各自有到期日 |
| Raccoon | `raccoonPoints` | `points` | 积分（`points/v1/balance`，单位 credit） | 分池；每日积分次日整额清零，没有到期日 |

两条必须同时成立的结论：

1. **除 ZCode 外，四个平台都是积分计量**，只是各平台积分价值不同（换算比不同、不可互换）。
2. **都是积分不等于可以相加**。唯一可相加的一份是 Trae + WorkBuddy 的可累积积分
   （两者上游单位相同），界面上叫「可累积积分合计」。

### 为什么界面上曾经写成「配额」和「points」

2026-11-17 之前，计量列给 Qoder 标「配额」、给 Raccoon 标「points」，而同一行的说明
写「赠送 2,587」「奖励积分 / 每日积分」。同一个数字在一列叫配额、在另一列叫积分，
读的人只能认为计量列在骗他。订正后的规则：

- 计量列只写上游真实单位：**积分**（ZCode 写 **Token**）；
- 口径差异由 `UNIT_CALIBER` 的限定语表达（tooltip 与说明位），不靠发明第二个名字；
- **所有过滤 / 分组 / 合计一律用内部键 `caliber`，禁止用展示名字符串**。

最后一条是这次改动真正的风险点：展示名统一后，任何 `unit === '积分'` 的过滤都会把
Qoder 与 Raccoon 误并进合计。实测数据（Trae 780 / WB 200 / Qoder 1,926 / Raccoon 2,124）
下，按展示名筛会得到 5,030，按 `caliber` 筛才是正确的 980。
该反例已被 `src/test/overview-detail.test.js` 钉成断言。

### 新增平台时的检查点

1. 在 `entitlement.ts` 的 `UNIT_LABEL` / `UNIT_CALIBER` 里登记展示名与限定语；
2. 确认它是否属于 `credit`（可累积积分）。不属于就不要出现在任何合计里；
3. 不要在前端另写一份单位名单——`overview-detail.ts` 与 `EntitlementOverview.tsx`
   此前各有一份，正是漂移的成因，现已收敛到 `entitlement.ts` 一处。

---

## 2. 保活模式：一个结论只能有一个来源

「保不保活」此前在前端是从 `tokenRefresh || oauthLogin` 反推的一个布尔，
而这两个能力位说的是「有没有静默续期能力」。一个布尔压不住三件不同的事实：

| 事实 | 谁关心 | 混淆后的表现 |
|---|---|---|
| 凭据会不会过期 | 用户决定要不要手动续 | ZCode 不会过期，却被写成「不参与保活」，读起来像漏配 |
| 网关有没有实现续期 | 决定能否自动修复 | Qoder 有上游端点但网关未实现，却被尾注写成「会按需续期」 |
| 定时轮覆不覆盖它 | 决定记录为空是不是故障 | 「不参与」与「跑了但没记录」共用一个灰标签 |

因此新增能力位 `keepaliveMode`（`src/platform/variant.js` 各渠道声明），三态：

| 模式 | 平台 | 界面文案 | 依据 |
|---|---|---|---|
| `scheduled` | Trae / WorkBuddy / Raccoon | 参与定时保活 | `scheduler.keepaliveCandidates()` 按本模式筛账号，每日轮逐个账号写 `lastKeepaliveAt` |
| `not-needed` | ZCode | 无需保活 | 客户端 JWT 无 `exp`、上游不发放 `refresh_token`，没有可续期的东西 |
| `not-implemented` | Qoder | 不保活 · 到期需手动更新 | `dt-` token 会过期（实测 `expired_at` = 导入时刻 +30 天），上游有 `jobToken/refresh`，但网关没有实现该链路 |

三处必须同源，改一处就要改三处：

1. `src/platform/variant.js` 的 `capability.keepaliveMode`（唯一声明处）；
2. `src/jobs/scheduler.js#keepaliveCandidates`（实际覆盖集合）；
3. `web/src/features/accounts/KeepaliveBoard.tsx` 与 `ChannelDetailDialog.tsx` 的文案（同一张表）。

`src/test/channels.test.js` 钉住两件事：每个渠道都下发三态之一；
`scheduled` 集合与旧判据（`tokenRefresh || oauthLogin`）集合完全相同——
即本次只收口判据来源，**没有改变任何账号的覆盖范围**。

### Qoder 为什么是 `not-implemented` 而不是 `scheduled`

补齐自动续期需要满足两个前提，目前都未验证：

1. `refresh_token`（`drt-`）是**轮换制**，旧值换新值即失效；
2. 续期请求必须带正确的 `machine_id`（上游按 `md5('machine:'+uid)` 前 36 位派生，
   见 `docs/02-technical/channels/qoder-integration-analysis-v2.md` 双区域附录）。

打错即作废既有凭据，属于「一次失败就把账号打死」的操作，未做多账号验证前不接。
当前处置：到期前用 `scripts/ops/export-qoder-token.js` 重新导出，
再走 `POST /v1/qoder/manual/import` 导入。

---

## 3. 「最近保活」列由谁写入

面板该列读 `accounts.last_keepalive_at`。此前只有每日轮写它，导致按需续期成功的账号
在当天 17:00 之前仍显示「尚无记录」，而尾注写着「会按需续期」——同一屏两个相反结论。
现在三条链路都写：

| 链路 | 触发时机 | 写入者 | 结果文案 |
|---|---|---|---|
| 每日保活轮 | 每日一次（时刻见 `scheduler-settings.keepaliveHour/Minute`） | `scheduler.runKeepalive` | `ok` / `fail: …` |
| 临期扫描（按需续期） | 每 15 分钟，命中临期判据时 | `scheduler.refreshExpiringTokens` | `ok（按需续期）` / `fail: …` |
| 请求前兜底 | 转发 / 签到取凭据时 | `auth.ensureAuth`（Trae / WorkBuddy）、`raccoon/auth.refreshAccount` | 同上 |

判据位与展示位的分工没有变（见 `src/auth/index.js#wbNeedsRefresh` 的注释）：
`lastRefreshAt` 只在**成功续期**时写，是 WorkBuddy 7 天周期续期的判据；
`lastKeepaliveAt` 是「最近一次保活尝试」的展示位，任何链路都写。
两列合并会让每日盖章永久压制周期续期窗口——2026-10-21 实测过，不要再合并。

### 空记录的三种解释

| 池的状态 | 含义 | 处置 |
|---|---|---|
| `参与定时保活` + 有记录 | 正常 | 无需动作 |
| `参与定时保活` + 尚无记录 | 刚导入未到轮次 / 调度未启动 / 续期全部失败 | 看「运维 → 定时任务」与任务日志 `task=keepalive` |
| `无需保活` / `不保活` + 空记录 | 设计使然 | 前者无动作；后者按 §2 手动更新凭据 |

### 到期列同样分三种，不能都写「均 7 日以上」

「Token 均 7 日以上」这句话在缺到期记录时是无依据的担保，因此 `keepalivePools`
把 `expiredAt` 为空的账号拆成两类计数：

| 计数 | 触发条件 | 界面文案 |
|---|---|---|
| `expiringSoon` | 有到期时间且 7 日内到期（含已过期） | `N 个账号 Token 7 日内到期` |
| `expiryUnknown` | 该平台**有**到期概念，但库里没有 `expiredAt`（典型：手动粘贴导入的 Qoder 未带到期时间） | `N 个账号到期时间未知` |
| `noExpiryConcept` | 上游确实不返回到期时间（ZCode 的 JWT 无 `exp`） | `无 Token 到期概念` |

`keepaliveOf` 的 `label` 同口径：ZCode 报「长期有效」，其余平台缺记录报「到期未知」。
把两者合并（此前一律报「长期有效」）会让同一个池既在卡片上写「到期需手动更新」、
又在行里写「长期有效」——与 §2 那处矛盾完全同形。

---

## 4. 验证方式

```
node src/test/channels.test.js            # 54 项：keepaliveMode 三态、集合等价、文案同源
node src/test/overview-detail.test.js     # 25 项：展示名统一 + 合计必须按 caliber 筛
node src/test/frontend-entitlement.test.js # 23 项：四平台取数键与单位
node src/test/unit.test.js                # 324 项：含按需续期写保活记录、候选集合排除 qoder/zcode
cd web && npx tsc -b && npx eslint src    # 类型与 lint
```

界面自查（面板 → 凭据池 →「最近操作与保活」）：

1. Qoder 卡片显示「不保活 · 到期需手动更新」，尾注对应段落**不含**「按需续期」；
2. ZCode 卡片显示「无需保活」，尾注说明没有可续期的东西；
3. Trae / WorkBuddy / Raccoon 卡片显示「参与定时保活」，且「最近保活」列有当日时刻；
4. 权益总览的计量列：ZCode 为 Token，其余四行为积分；「可累积积分合计」只含 Trae + WorkBuddy。
