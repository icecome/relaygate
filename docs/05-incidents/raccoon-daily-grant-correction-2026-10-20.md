# 每日积分发放机制订正 + 密码登录保活通道（2026-10-20）

## 一、订正：早期判断是错的

早期（2026-10-16/18）我在代码与文档里写的是：

> 「网关侧代打 `desktop/v1/login/points/grant`，等价于替用户当天开一次客户端，
> 把 300 分从『当天作废』变成『7 天窗口』。」

**这个前提是错的。** 它来自一个未经验证的假设：「桌面端每次启动都调 grant ⇒ grant 就是发放点」。

更早（2026-10-15）的另一条结论其实**与它自相矛盾**，我当时读到了却没发现：

> 「没有 daily/checkin/sign_in 发放端点… 唯一能主动调的发放端点是**一次性**的
> `POST /api/web/desktop/v1/login/points/grant`」

「只有一次性端点」与「能触发每日发放」不能同时成立。基于矛盾前提写完了整个保活功能，
且连续两天（10-19/10-20）的告警都指向它，我却一直在归因 token / 上游状态，
**没回头质疑这个前提**。

## 二、实测证据：发放载体是「真实登录」

### 发放侧

| 探测 | 结果 |
|---|---|
| 全量账单扫描（含不带 `type` 的 20 条） | 10-19、10-20 **一条 daily_grant / daily_expire 都没有** |
| `POST desktop/v1/login/points/grant` | 200 `granted:false` —— 幂等，但**不触发发放** |
| grant + `X-Client-Device-ID`（客户端 UA 里的设备标识） | 仍不触发 |
| `POST auth/v1/refresh`（access 当 refresh） | 不触发 |
| `balance` / `model_catalog` / `bills` / `user_info` | 均不触发 |
| IAM `/api/iam/v1/account` 的 `last_login_at` | 停在 10-18，**不因我们的任何调用更新** |
| 客户端进程 | 未运行（已确认） |

### 时间戳交叉验证

| 日期 | daily_grant `created_at` | 客户端本地 `~/.box-agent/config/` 写盘 |
|---|---|---|
| 10-15 | 09:14:46 | `auth.json` 09:20:10 |
| 10-16 | 08:56:34 | — |
| 10-17 | 11:43:53 | — |
| 10-18（Anthony） | **22:46:05** | `mcp.system.json` **22:42:15** |
| 10-18（Olivia） | **22:42:24** | 同上 |

10-18 两笔与客户端写盘时刻**精确同步** ⇒ 那是**桌面客户端真实运行时**产生的。

规则原文（i18n `dailyGrantRule`，zh/en/ja 一致）：

> 「每日积分每天 00:00 发放，默认当日 24:00 清零，**当天登录后**有效期延长至 7 天。」

### 影响量化（无损失）

- Anthony：`daily_points=300`，未到期批次 4 笔共 **1200 分**（至 10-24）
- Olivia：`daily_points=600`，未到期批次 3 笔共 **900 分**（至 10-24）

10-19/10-20 是「上游没发新额度」，**存量未作废**。

## 三、正解：`login_with_password` 是唯一可编程复刻的真实登录

客户端的**真实登录**端点是 `login_with_qrcode_code` / `login_with_sms` / `login_with_password`。
其中只有密码登录能无人值守自动化 ⇒ 网关每日代登的正解。

### 协议（实测）

- 端点：`POST /api/web/auth/v1/login_with_password`
- 头：**只有** `Content-Type`（无 Authorization、无业务头）
- body：`{ nation_code, phone, password }`
- ⚠️ **phone 与 password 都要加密**（AES-128-CFB，密钥 `senseraccoon2023`）：
  - 缺/明文 → `100003 params_encryted_error`
  - 加密后密码错 → `100002 params_invalid_error`（说明加密对了）
- 成功返回 `access_token` + `refresh_token`（可落库续用）

### 实现

| 文件 | 改动 |
|---|---|
| `src/raccoon/product.js` | 新增 `encryptSecret()`（与 `encryptPhone` 同算法，供密码字段用）；`summarizeDailyPoints()` 新增 `grantedToday` |
| `src/raccoon/auth.js` | 新增 `loginWithPassword()`；`persistLogin(credential, opts)` 支持自定义 label |
| `src/raccoon/credits.js` | `touchDailyKeepalive()` 改为**优先密码真实登录**，无密码则回退观测；返回 `relogged` 标记 |
| `src/platform/variant.js` | 新增 `loginWithPassword` / `resetPassword` 路径 |
| `src/credentials/db.js` | 新增 `raccoon_phone_enc` / `raccoon_password_enc` / `raccoon_nation_code` 列 |
| `src/credentials/store.js` | 密码字段用统一密钥加密存储；`safeTok` 剥离明文；`list()` 只回 `hasPasswordLogin` 布尔值 |
| `src/jobs/raccoon-keepalive.js` | 模式标记 `password-login` / `observe`；`upstreamSkipped` 不告警 |
| `src/routes/raccoon.js` | 新增 `PUT /accounts/:id/password-login`（**先试登录成功才落库**，且校验登录到的账号与目标一致） |
| 前端 | 账号行「配置密码」按钮 + 密码表单弹层；文案改为如实区分「上游未发放」 |

### 保活任务现在的行为

1. **有密码** → `login_with_password` 真实登录（触发发放）+ 落库新令牌对 + 读当日账单确认 7 天有效期
2. **无密码** → 打 grant（幂等）+ 读账单如实上报
   - `ok` / `not_extended`（真异常，告警）/ `upstream_not_granted`（上游状态，**不告警**）

## 四、验证

| 项 | 结果 |
|---|---|
| `npm test` | exit 0，全绿；raccoon **44/44**（新增 `encryptSecret`、密码登录端到端两个回归） |
| `biome check`（改动文件） | exit 0 |
| `npm --prefix web run build`（含 tsc -b） | exit 0 |
| 真实上游负路径 | 错密码 → `100002 params_invalid_error`（加密链路正确） |
| 密码凭据存储 | 加密落盘 / 读取正常；`list()` 不回显明文 |
| 手动跑保活 | `upstreamSkipped=2 failed=0`，`mode=observe`（未配密码时） |

## 五、待办

- **需要用户提供 Anthony 的登录密码**（`password_status: set`，已设过），
  才能验证「密码真实登录 → 当日 daily_grant 产生」这条完整链路。
  验证后即可让网关每日代登，摆脱「必须开桌面客户端」。
- Olivia 的 `password_status: unset`（未设密码），需先设密码才能走同一条路。
