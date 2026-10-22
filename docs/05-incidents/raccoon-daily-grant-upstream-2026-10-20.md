# 每日积分「上游未发放」实证与保活任务误报修复（2026-10-20）

## 一、现象

```
[relay-gate] 小浣熊每日积分未延长 ×2
详情: RaccoonAnthony-3389: 当日尚未看到 daily_grant 账单，无法确认有效期（可能发放有延迟）
      RaccoonOlivia-3389: 当日尚未看到 daily_grant 账单，无法确认有效期（可能发放有延迟）
成功: 0  失败: 2
```

保活任务 09:05 正常执行、`grant` 也调通了，但两个账号都报「未延长」。

## 二、根因（实测穷举，不是代码 bug）

**上游从 2026-10-19 起连续两天没有产生任何 `daily_grant` / `daily_expire` 账单。**

### 实证链条

| 探测 | 结果 |
|---|---|
| 全量账单扫描（含不带 `type` 的 20 条） | 10-19、10-20 **一条都没有** |
| `POST desktop/v1/login/points/grant` | 200 `granted:false`（幂等，但不触发发放） |
| `POST auth/v1/refresh`（access 当 refresh） | 200，换出完整令牌对，**不触发发放** |
| `GET points/v1/balance` / `model_catalog` / `bills` | 均 200，不触发 |
| grant + `X-Client-Device-ID` | 仍 `granted:false`，不触发 |
| IAM `/api/iam/v1/account` 的 `last_login_at` | 停留在 10-18，**不因我们的任何调用而更新** |
| 客户端进程是否在跑 | 未运行（已确认） |

### 时间戳交叉验证：发放载体是「真实客户端登录」

| 日期 | daily_grant `created_at` | 同日 `~/.box-agent/config/` 写盘时刻 |
|---|---|---|
| 10-15 | 09:14:46 | `auth.json` 09:20:10 |
| 10-16 | 08:56:34 | — |
| 10-17 | 11:43:53 | — |
| 10-18（Anthony） | **22:46:05** | `mcp.system.json` **22:42:15** |
| 10-18（Olivia） | **22:42:24** | 同上 |

10-18 那两笔与客户端本地文件写盘时刻**精确同步** —— 那是**桌面客户端真实运行时**产生的。
规则原文（i18n `dailyGrantRule`，三语一致）：

> 「每日积分每天 00:00 发放，默认当日 24:00 清零，**当天登录后**有效期延长至 7 天。」

⇒ **发放触发点是真实客户端登录，网关代打 grant 无法复刻。**

### 关键排除：这不是积分损失

两个账号的**未到期** daily_grant 批次：

- Anthony（`daily_points=300`）：10-15/16/17/18 共 4 笔 **1200 分**未到期
- Olivia（`daily_points=600`）：10-14/17/18 共 3 笔 **900 分**未到期

每日池余额与未到期批次一致 ⇒ 10-19/10-20 只是「上游没发新额度」，**没有作废任何存量**。

## 三、修复内容

把「我们没延长」与「上游没发放」**分开归类**，不再让上游状态冒充成故障。

### 1. `src/raccoon/credits.js` —— `touchDailyKeepalive()`

读不到当日 `daily_grant` 时，返回独立 reason：

```js
return {
  ok: false,
  reason: 'upstream_not_granted',   // 原为 no_daily_grant_today，且被上层归为 notExtended
  granted,
  message: '上游尚未产生今日 daily_grant 账单（每日积分由真实客户端登录触发，'
    + '网关代打不生效）；已尝试当日登录请求，无可延长对象。',
};
```

### 2. `src/raccoon/product.js` —— `summarizeDailyPoints()`

新增 `grantedToday` 字段（按 `grant_at` 本地日期判定），面板据此显示上游状态而非「签到失败」。

### 3. `src/jobs/raccoon-keepalive.js`

- summary 新增 `upstreamSkipped` 计数，`upstream_not_granted` / `no_daily_grant_today` 归入它
- `lastError` 只统计 `failed + notExtended`，不含 `upstreamSkipped`
- **告警只对 `notExtended` / `failed` 发**；`upstreamSkipped` 不发通知（每天一条噪声 + 误判成「签到坏了」）

### 4. 面板（`ImportRaccoonDialog.tsx` / `raccoon.ts`）

- 类型补 `upstreamSkipped` / `grantedToday`
- 文案改为「上游未发放 N」而非「失败」
- 保活说明区加粗说明：**每日积分由上游在真实客户端登录时发放，网关代打不触发**

## 四、验证

| 项 | 结果 |
|---|---|
| `npm test` | exit 0，全绿；raccoon **42/42** |
| 新增回归 | `summarizeDailyPoints.grantedToday`（今日/历史/空输入三态） |
| `biome check` | 4 文件 exit 0 |
| `npm --prefix web run build`（含 tsc -b） | exit 0 |
| 手动跑一轮保活 | `ok=0 notExtended=0 **upstreamSkipped=2** failed=0`，无告警 |

## 五、结论与后续

**这不是「签到失败」，是上游未发放。** 网关侧能做的（代打 grant、refresh、自校验）都已做到，
发放本身依赖真实客户端登录，网关无法复刻，也**不应**为了「看起来成功」而伪造 ok。

若要让每日积分稳定到账，唯一可靠路径是**保持桌面客户端真实登录**（开着或每天登一次）；
网关负责的「没开客户端的 7 天有效期延长」在该账号历史上已实证生效（10-17/10-18 都是 7 天）。
