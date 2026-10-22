# 代码审查报告 — RelayGate 待提交变更（2026-10-22）

> **审查框架：** SPEAR（Security / Performance / Error Handling / Architecture / Reliability）
> **审查范围：** 42 个已跟踪变更文件（+2885/−219 行）+ 20 个新增源码/脚本
> **审查模式：** 逐文件 PR 审查 + 证据验证（阶段 2.5 全量执行）
> **风险等级：** 高（Red）—— 涉及凭据存储、密码登录、外部上游、管理面 API
> **首轮评分：** 54/100（🟠 SIGNIFICANT ISSUES）
> **修复后：** 全部 P0/P1/P2/P3 项已处理，见文末「修复验证」

---

## 1. 问题汇总

| 级别 | 数量 | 编号 |
|------|------|------|
| 🔴 CRITICAL | 2 | C-01, C-02 |
| 🟠 MAJOR | 6 | M-S1, M-S2, M-R1, M-R2, M-R3, M-R4, M-E1 |
| 🟡 MINOR | 7 | m-01 … m-07 |
| 🔵 NIT | 2 | n-01, n-02 |

> M-E1 与 M-R1..M-R4 合计 6 项 MAJOR（M-E1 计入 MAJOR 错误处理类）。

---

## 2. CRITICAL

### C-01 密码登录路由引用未定义标识符，功能恒 400

- **文件：** `src/routes/raccoon.js:307`
- **证据：** 本文件内无 `raccoonAuth` 声明（正确变量是第 28 行的 `auth`）；
  加载真实路由模块并以 mock req/res 调 handler，实测返回
  `HTTP 400 {"message":"密码登录验证失败，凭据未保存：raccoonAuth is not defined"}`。
- **影响：** 「配置密码登录」100% 不可用，且错误信息指向「密码错」，
  用户会反复改密码去追一个代码 bug。
- **修复：** 改用 `auth.loginWithPassword`，并把错误分级为
  内部错误（500）/ 上游失败（502）/ 参数凭据（400）。

### C-02 `GET /v1/credentials/:id` 明文回传密码与手机号

- **文件：** `src/routes/credentials.js:301`（配合 `src/credentials/store.js:218`）
- **证据：** 起真实服务 + 真实 HTTP，造带 `raccoonPassword` / `raccoonPhone`
  的账号，响应体实测 `含密码明文? true / 含手机号明文? true`；
  对照 `GET /v1/raccoon/accounts` 两项均为 false。
- **影响：** 任何持管理密钥者都能拿到用户的**上游登录密码**（可复用、可撞库）。
- **修复：** 逐项解构剥离 `token/refreshToken/apiKey/raccoonPhone/raccoonPassword`，
  只回 `hasPasswordLogin` 布尔值。

---

## 3. MAJOR

| # | 文件:行 | 问题 | 验证 | 修复 |
|---|---------|------|------|------|
| M-S1 | `src/credentials/store.js:49` | `safeTok()` 只剥 `raccoonPassword`，漏 `raccoonPhone`。`store.update()` 返回 `safeTok(get(id))`（get 默认解密），于是 `PATCH /v1/credentials/:id`、`POST /v1/raccoon/accounts/:id/balance` 都带出手机号 | 真实 HTTP 实测：PATCH 与 balance 出口 `phone=true` | `safeTok` 增加剥 `raccoonPhone`；`redact()` 同步剥离并加注释说明两层兜底 |
| M-S2 | `src/routes/raccoon.js:315` | 账号不一致分支无条件 `store.remove(account.id)`，而 `persistLogin` 命中既有账号时返回的正是**已存在的另一条账号** | 造 A/B 两账号，执行该分支后 B 被误删（实测） | 改为只中止 + 409 提示，不删任何数据 |
| M-R1 | `src/auth/index.js:47` + `src/jobs/scheduler.js:323` | `wbNeedsRefresh` 读 `lastKeepaliveAt`，而每日保活轮每天无条件写该列 ⇒ 「7 天」窗口被永久重置，周期续期永不触发 | 直接调 `wbNeedsRefresh`：0/1/3/6 天全 false；读 scheduler 确认为无条件写 | 新增 `last_refresh_at` 列作判据位，`wbNeedsRefresh` 只读它 |
| M-R2 | `src/auth/index.js:117` | 续期**失败**也写 `lastKeepaliveAt` ⇒ 一次网络抖动把重试压满 7 天（正是该机制要兜的场景） | 构造 fail 结果 + 刚写 1 分钟 → `wbNeedsRefresh=false` | 失败只写 `lastKeepalive*`，不写 `lastRefreshAt` |
| M-R3 | `src/raccoon/auth.js:338` | 幂等键只认 `userId`；`user_info` 失败被吞成 `{}` → `userId=null` → 每次 `store.add()` | mock userInfo 500 连跑 3 天：账号 1→2→3 | 加手机号二级幂等键；且「没查到 userId」不再写 null 抹掉既有身份 |
| M-R4 | `src/raccoon/credits.js:380` | 令牌写回用 `acct.id`，而 `persistLogin` 可能命中另一条账号 ⇒ 同一凭据写进两条账号 | 造同 userId 的 A/B，实测两条 token 都变成新值 | 写回 `account.id`（实际命中那条） |
| M-E1 | `src/routes/raccoon.js:330` | 密码登录 `catch` 把所有异常映射成 400「密码登录验证失败」，内部缺陷与用户输入错误不可区分 | C-01 的 ReferenceError 正是被这层包装 | 按 内部/上游/参数 三级映射 500/502/400 |

---

## 4. MINOR / NIT

| # | 文件:行 | 问题 | 处理 |
|---|---------|------|------|
| m-01 | `src/raccoon/client.js:202` | `HOST` 导出为加载期快照，与 `hostOf()` 活值语义分叉，且无消费者 | 保留兼容 + 注释明确「请求路径一律用 hostOf」 |
| m-02 | `src/platform/variant.js:487` | `credentialCipherKey` 与 `product.PHONE_CIPHER_SECRET` 重复定义，且无人读取 | 删除 variant 那份，注释指明单一事实源 |
| m-03 | `src/jobs/raccoon-keepalive.js:166` | `summary.skipped` 声明后从无自增、也无消费者 | 删除该字段并注释原因 |
| m-04 | `src/jobs/raccoon-keepalive.js:104` | `keepaliveOne` 上方两个连续 JSDoc，前者被覆盖 | 合并为一份 |
| m-05 | `src/notify/settings.js:38` | `raccoon_keepalive_fail` 未登记 EVENTS（能发但面板无法单独关闭） | 登记进 EVENTS + `EVENT_TITLES` |
| m-06 | `src/raccoon/product.js:402` | `decodeURIComponent` 对非法编码抛 `URIError`，与本函数 `INVALID_QR_PATH` 契约不一致 | 包成 `INVALID_QR_PATH` |
| m-07 | `web/.../ImportRaccoonDialog.tsx:214,491` | 开启保活的 toast 与说明仍称「把 300 分延长到 7 天」，与同文件订正后的「代打不触发发放」自相矛盾 | 改为「代做一次真实登录并如实上报」 |
| n-01 | 仓库根 | 游离文件 `100000`（一次 `node -e` 的报错输出） | 已删除 |
| n-02 | `scripts/` | 15 个探针脚本与生产脚本同级，且会消耗真实积分 | 移入 `scripts/probes/`，补 README 与逐个积分警告头 |

---

## 5. 未验证项声明

| 维度 / 范围 | 未验证原因 |
|------------|-----------|
| 真实上游端到端（密码登录 / 扫码 / 每日积分） | 需真实账号密码，仅做 mock 上游 + 真实 HTTP 网关层验证 |
| WorkBuddy 11128 在生产上游的持续有效性 | 上游渠道校验是灰度开关，当前时刻无法复现 |
| 浏览器实际渲染 | 无浏览器自动化环境；仅 `tsc -b` 与 `eslint`（均 exit 0）静态验证 |
| 测试有效性（变异测试） | 只跑全量绿灯，未逐个把被测实现替换成空实现 |

---

## 6. 修复验证

新增 `scripts/verify/verify-review-fixes.js`（纯本地，mock 上游），12 项断言全通过：

```
[C-01]   PUT /accounts/:id/password-login 返回 200 configured=true
[C-02]   GET /v1/credentials/:id 不含密码/手机号，含 hasPasswordLogin
[M-S1]   PATCH /v1/credentials/:id 不含密码/手机号
[M-S1]   GET /v1/credentials 列表不含密码/手机号
[M-S1]   POST /raccoon/accounts/:id/balance 不含密码/手机号
[M-S1]   GET /v1/raccoon/accounts 含 hasPasswordLogin 但不含明文
[M-S2]   填「另一个账号」的手机号后，既有账号仍在
[M-R3]   连跑 3 次密码登录，账号数不增
[M-R1/R2] 每日保活盖章不能压制 7 天周期续期
[m-06]   非法编码不抛 URIError
[m-02]   variant 里不再重复定义 credentialCipherKey
[m-05]   raccoon_keepalive_fail 已登记可开关
```

全量测试 16 个套件绿灯（unit 300 / raccoon 44 / qoder 76 / channels 44 /
protocol 36 / stream-gate 19 / security 41 / growth 11 / rtk 32 /
local-answer 111 / qr 38 / store-concurrency 11 / shutdown 9 /
rate-limit 7 / oauth-listener 5 / startup-checks 17）。
`biome check` / `tsc -b` / `eslint` 均 exit 0。
