# ZCode 运营面接入说明（限时套餐自动探测与领取）

> 接入范围：**仅账号运营面**——本机凭据导入、限时套餐（赠送额度）探测与领取、额度查询、定时任务。
> **不含对话转发**：ZCode 的 messages 通道按设备指纹+追踪头识别客户端，头形态写错会触发上游 3012
> 「unusual activity」真风控。在未充分验证前刻意不并入转发池（`capability.chat=false`）。

## 它解决什么

ZCode 客户端会不定期下发「限时领取」的赠送套餐（如 `ZCode Trust Build`：GLM-5.3-Flash ×1 亿 tokens，
一次性或按日发放）。官方只在客户端里弹横幅，关闭就错过。本模块在 RelayGate 内定时探测并自动领取：

- 每日 **00:30** 与 **21:30**（本地时区）各探测一轮
- 有可领套餐 → 自动解验证码 → 自动 claim → 通知
- 已领取过（上游 1003）幂等跳过，不会重复请求
- 触发风控（3012）立即中止该账号并单独告警

## 上游链路（实证）

```
POST https://zcode.z.ai/api/v1/event/report           ← app_launch + app_daily_active（无鉴权）
GET  https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version=   ← 可领套餐列表
POST https://zcode.z.ai/api/v1/zcode-plan/billing/claim  {"plan_id"}    ← 领取（需验证码）
GET  https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=   ← 额度
GET  https://zcode.z.ai/api/v1/client/configs?app_version=               ← 验证码 scene 配置
```

业务码语义（`platform/variant.js` → `errors`）：

| code | 含义 | 处理 |
|---|---|---|
| 0 | 成功 | 落库 + 通知 |
| 1001 | 套餐不存在或已下架 | 失败 |
| 1002 | 活动结束 | 失败 |
| 1003 | 已领取过 | **幂等成功**（already） |
| 1004 | 不符合条件 | 失败 |
| 1005 | 今日名额用完 | 失败 |
| 3001 | 参数错误 | 失败（通常是头不全） |
| 3007 | 验证码校验失败 | **换码重试一次** |
| 3012 | 真风控 unusual activity | **中止该账号 + 告警** |

关键实测结论（写代码时勿凭直觉改）：

1. `billing/preview` **必须带全套客户端身份头**（`X-ZCode-App-Version` / `X-Platform` / `X-Device-Mid` …），
   裸请求直接 `3001 parameter error`。
2. `client/configs` **禁止带 `platform` 参数**，带则 `3001`。
3. `billing/claim` 的 `X-Platform` 是 `<platform>-<arch>` 形态（如 `win32-x64`），缺版本/平台头即使
   验证码有效也 `3007`。
4. 验证码参数（`certifyId`）**一次性**，复用会被官方客户端同款 F008 重复提交检测拒绝；每次 claim 现解。
5. 激活事件上报（app_launch/app_daily_active）是活动投放资格的疑似信号——官方客户端可见活动但
   preview 为空的不符点，多与漏报日活相关。探测前先上报，失败不阻断。

## 快速开始

### 1. 导入本机账号

前提：本机装有 ZCode 桌面客户端且登录过（凭据文件 `~/.zcode/v2/credentials.json`）。

```powershell
# 方式 A：调用 API（管理密钥鉴权）
POST /v1/zcode/local/import

# 方式 B：命令行脚本
node scripts/ops/zcode-import-local.js
```

导入内容：`zcodejwttoken`（列级 AES-256-GCM 加密入库）、`user_id`、设备档案。
客户端的 JWT 无 `exp` 字段、也不返回 refresh_token，**长期有效，无需保活**。

> 凭据解密密钥派生自客户端 asar 实现：`sha256("zcode-credential-fallback:<platform>:<homedir>:<username>")`。
> 若客户端重装或系统用户名变更导致解密失败，设 `ZCODE_CREDENTIAL_SECRET` 显式指定。

### 2. 开启定时任务

```powershell
# .env
ZCODE_REWARDS_ENABLED=true
```

或热改：`POST /v1/zcode/settings {"enabled": true}`。
时段可在面板设置或 env 调整（默认 00:30 / 21:30）。

### 3. 验证

```powershell
# 状态（含求解器可用性）
GET /v1/zcode/status

# 手动跑一轮（探测 + 领取）
POST /v1/zcode/rewards/run

# 只探测不领取
POST /v1/zcode/accounts/<id>/rewards/probe

# 验证码自检（真实求解一次）
POST /v1/zcode/diagnose/captcha
```

结果在面板「任务日志」中查 `task=zcode-rewards`；通知走既有渠道
（事件：`zcode_reward_claimed` / `zcode_reward_failed` / `zcode_reward_risk`）。

## 架构与文件

```
src/platform/variant.js        ZCODE 变体表（域名/路径/业务码/能力位/时段）—— 单一事实源
src/zcode/
  fingerprint.js               每账号成套桌面设备档案（platform×arch×os×screen 绑定 + device_mid）
  identity.js                  billing 面身份头（pio 头集合；顺序与取值对齐官方客户端）
  client.js                    HTTP 通道（信封解析 / 业务码错误 / 代理复用）
  captcha.js                   阿里云无感验证码求解（子进程调 solver.js）
  rewards.js                   激活上报 / preview / claim / balance（业务核心）
  local.js                     本机客户端凭据解密导入（AES-256-GCM）
src/jobs/zcode-rewards.js      每日 00:30/21:30 定时（错峰 / 幂等 / 任务日志 / 通知）
src/routes/zcode.js            /v1/zcode 管理端点
scripts/ops/zcode-import-local.js  命令行导入
scripts/probes/zcode-e2e.js           端到端演练（真实打上游）
```

### 与既有系统的关系

- **账号库共用** `accounts` 表，`edition='zcode'` 区分；新增列 `api_key_enc` / `fingerprint` / `mode`
  （均可空，旧账号零影响）。
- **转发池隔离**：`pool.editionOk` 走 `variant.canChat` 能力位，zcode 账号不可能被 Trae/WorkBuddy
  请求选中；签到链、token 保活、账单扫描同样按能力位/白名单显式排除 zcode。
- **余额刷新**：`upstream/balance.js` 已分流——zcode 账号走自己的 `billing/balance`
  （token 计量），面板余额列显示剩余 token 数。

### 验证码求解器

`billing/claim` 强制阿里云无感验证码。求解器复用 `zcode2api/captcha_node/solver.js`
（Node + happy-dom 模拟浏览器，无真实浏览器依赖），通过 `ZCODE_CAPTCHA_SOLVER_DIR` 指向：

```
默认：C:\opt\workstations\project\zcode2api\captcha_node
首次：在该目录 npm install（本机已装好）
```

实测单次求解 2–8 秒，成功率约 2/3（阿里云 pe 字节码 VM 偶发 stall），代码内置 3 次重试，
重试后仍失败记 `failed` 并在下轮重试——对每日两轮的节奏完全够用。

## 配置项

| env | 默认 | 说明 |
|---|---|---|
| `ZCODE_REWARDS_ENABLED` | `false` | 定时任务总开关（默认关，避免影响现有池） |
| `ZCODE_REWARD_HOUR_1` / `_MINUTE_1` | `0` / `30` | 第一探测时段 |
| `ZCODE_REWARD_HOUR_2` / `_MINUTE_2` | `21` / `30` | 第二探测时段 |
| `ZCODE_REWARD_SPREAD_MINUTES` | `10` | 多账号错峰窗口（单账号无影响） |
| `ZCODE_REWARD_AUTO_CLAIM` | `true` | 关闭则只探测通知、不实际领取 |
| `ZCODE_APP_VERSION` | `3.14.4` | 客户端版本头 |
| `ZCODE_TIMEOUT_MS` | `25000` | 上游超时 |
| `ZCODE_CAPTCHA_SOLVER_DIR` | zcode2api 路径 | 求解器目录 |
| `ZCODE_NODE_PATH` | `node` | Node 可执行文件 |
| `ZCODE_CAPTCHA_RETRIES` | `3` | 单次领取的求解重试次数 |
| `ZCODE_CREDENTIAL_SECRET` | 派生 | 客户端凭据解密密钥（一般不用设） |

时段/开关也可在 `.trae-api/zcode-settings.json` 热改（文件 > env > 默认）。

## 计量口径隔离（关键约束，改代码前必读）

ZCode 的额度单位是 **token**（单包量级 1e8），而 RelayGate 既有「积分」体系
（balance 列 / entitlement_snapshot.packs / credit_history，单位 credit，量级 1e3）
是两套完全不同的计量。**禁止把 token 数写进任何积分口径**，否则：

- 面板「可用额度 / 今日消耗」被抬高约 4 个数量级（实测单账号 86,560,855 tokens
  混进 ~5,400 credits 的日消耗，`totalUsed` 从 5,437 变 902,822,370）；
- 「3 日内到期积分」同样被污染；
- pool 的 FEFO 排序、`MIN_BALANCE_TO_USE` 过滤、低余额告警读到的是 token 数。

约定（当前实现已遵守）：

| 位置 | ZCode 写入 | 积分消费方 |
|---|---|---|
| `accounts.balance` | 恒 `null` | pool / credit-alerts / 面板余额列 |
| `entitlement_snapshot.packs` | **不写** | `creditTotals` / `summarizeExpiry` / `summarizeFefo` / FEFO 排序 |
| `entitlement_snapshot.tokenBuckets` | ✔ 写（token 桶 + `tokenRemaining`） | 无积分消费方 |
| `credit_history` | **不写** | `/v1/admin/credit-history` 的 `totalUsed` |

前端展示：CredentialsPage / OverviewPage 对 ZCode 账号显示 `tokenRemaining` 并标注
`tok` 单位，不并入积分。

- 历史污染修复：`node scripts/ops/zcode-fix-credit-pollution.js --apply`（先不带参数预览）
- 回归验证：`node scripts/probes/zcode-verify-credit-isolation.js`
- 影响面盘点：`node scripts/probes/zcode-credit-impact.js`

---

## 风险与边界

- **只自动领取本机已登录账号自己的活动奖励**，不做多账号批量刷活动——那属于风控对象。
- 高频调用 `billing/claim` 会触发 429；定时任务每日两轮 + 1003 幂等跳过，天然保守。
- `3012` 视为真风控：立即中止该账号本轮并告警，**不会**自动换指纹重试（换设备是人工决策，
  走 `POST /v1/zcode/accounts/:id/fingerprint/rotate`）。
- 验证码 `certifyId` 一次性，绝不复用。
- 转发面（messages 通道）未启用；接入前需独立账号验证头形态，相关字段已预留在
  `variant.paths.messages`。
