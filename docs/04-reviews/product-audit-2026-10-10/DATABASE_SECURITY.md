# DATABASE_SECURITY — 数据库与安全审计
**Product Professor · 2026-10-10 · commit `2a2ec43`**

---

## 0. 部署前提（决定一切严重性）

| 项 | 值 | 证据 |
|---|---|---|
| 默认监听 | `127.0.0.1` | [src/config.js:94](../../../src/config.js#L94) `HOST` env 默认 `127.0.0.1`；[index.js:184](../../../src/index.js#L184) fallback 链 `['::','127.0.0.1']` |
| `.env.example` | `HOST=127.0.0.1`，注释「跨机访问请显式配置（并自配防火墙）」 | 已确认 |
| 用户 | 单人单机 | 产品前提 |

**本报告所有严重性分两栏：「默认部署」与「对外暴露」。** `HOST≠127.0.0.1` 会让多条 P2 立即升为 P0。

---

## 1. 鉴权链全景（按实际代码，非文档）

```
[管理面板请求] /v1/admin/* · /v1/credentials/* · /v1/api-keys/*
    └─ authenticateAdmin (middleware/auth.js:54-68)
         ├─ DB kind=login 密钥（SHA-256 查表，api-keys.js:316-321）
         └─ 或 env ADMIN_KEY（auth.js:21-27）
    └─ 无登录密钥时：POST /v1/api-keys/setup/login-key（Origin/sec-fetch-site 闸门）

[客户端转发请求] /v1/chat/completions · /v1/messages · /v1/responses
    └─ authenticate (auth.js:30-51) — 仅 DB kind=access 密钥（登录密钥被拒）
    └─ canUseModel ACL（middleware/model-access.js，scopes + resources）
    └─ keyRateLimit（index.js:110-117 / 113-114）
    └─ 路由

[/status]  authenticateAdminOrPublic（默认需鉴权，STATUS_PUBLIC=true 则免）
[/health]  免鉴权（index.js:69）
```

**关键结构事实**：
- 管理密钥与访问密钥**类型分离**（`kind=login` vs `kind=access`），互相不可用 ✅
- 管理面走 `Authorization: Bearer` 头（无 cookie）→ **天然免疫经典 CSRF**，不依赖 SameSite ✅
- `ADMIN_KEY` env 值可访问转发面且**绕过模型 ACL**（`canUseModel(null-authKey)` 直接放行，`auth.js:122-126` 注释声明为"管理域天然放行"）。**这是设计意图，但范围很宽。**
- 已移除 `?key=` 查询参数鉴权 ✅

---

## 2. 前次审查的两条 MAJOR：**均已修复**（本次独立复核）

| ID | 前次结论 | 本次复核 |
|---|---|---|
| **M-S5** 平台密钥 `resources` ACL 静默绕过 | MAJOR | ✅ **已修复**：[middleware/model-access.js:50-59, 96-98, 115](../../../src/middleware/model-access.js#L96-L115) 现在 `platformResourceGate()` 对 workbuddy（:97）与 trae（:115）两个分支都调 `canInvokeModel`；回归测试在 [security.test.js:123-142](../../../src/test/security.test.js#L123-L142)（含 HTTP 层 403） |
| **M-S6** provider apiKey 明文落盘 | MAJOR | ✅ **已修复**：[model-router/store.js:89-95](../../../src/model-router/store.js#L89-L95) `normalizeProvider` 剥离 `apiKey` 只留 `apiKeyEnv`；[dispatch.js:14-18](../../../src/model-router/dispatch.js#L14-L18) 只从 `process.env[apiKeyEnv]` 解析；根与运行时 `model-router.json` 均为 `apiKey: null` |

**这是本项目最值得肯定的一点**：高危问题被修了，且配了回归测试。

---

## 3. 安全发现

### 🔴 P1-004 — OAuth 本地回调监听器可注入任意凭据

**代码**：
- [src/credentials/oauth.js:161](../../../src/credentials/oauth.js#L161) 监听 `127.0.0.1:17388`
- [oauth.js:152-155](../../../src/credentials/oauth.js#L152-L155) — **GET 分支调 `handleCallbackParams`**
- [oauth.js:245-260](../../../src/credentials/oauth.js#L245-L260) — **`completeLogin(creds)` 在 state 不匹配时只打一条 console 警告（"仅告警不拒绝"）**

**对比**：`POST /v1/credentials/oauth/complete`（[credentials.js:337-369](../../../src/routes/credentials.js#L337-L369)）**是** state 校验的（`oauth.verifyAndConsumeState`）。

**攻击路径**：
```
GET http://127.0.0.1:17388/authorize?refreshToken=X&accessToken=Y&userId=Z
```
GET 分支**无 Origin 校验、无 state 校验** → 任意本地进程，或任意网页通过 `<img>`/`no-cors` 导航，即可把攻击者控制的账号注入凭据池。注入后可污染调度，或将聊天流量导向攻击者的账号。

| 部署形态 | 严重性 |
|---|---|
| 默认（本机） | 🟠 P2（需访问恶意网站或本地进程） |
| `HOST≠127.0.0.1` | 🔴 **P0**（远程无认证写入） |

**修复**：GET 分支同样强制 state 校验 + 加 Origin/Referer 白名单；或将回调参数改为仅 POST 接收。

---

### 🟠 P1-008 — 转发面默认无限流

**代码**：[src/middleware/rate-limit.js:11-17](../../../src/middleware/rate-limit.js#L11-L17)
```js
const env = Number(process.env.KEY_DEFAULT_RPM || 0);
return ... : 0;   // 0 = 不限
```
`.env.example` **未定义 `KEY_DEFAULT_RPM`** → **任何持有一把访问密钥者可无限消耗真实额度**，且 [index.js:39](../../../src/index.js#L39) `express.json({limit:'10mb'})` 允许 10MB 请求体。

限流是**按密钥**（`req.apiKeyId`）而非按 IP，桶在内存 `Map`，>5000 键才清理。

**修复**：`.env.example` 加 `KEY_DEFAULT_RPM=60`；或对未设 rpm 的密钥给一个保守默认值。

---

### 🟠 P2-009 — 登录密钥无盐 SHA-256

**代码**：[src/credentials/api-keys.js:57-59](../../../src/credentials/api-keys.js#L57-L59) `hashKey = sha256(plain)`

- 生成密钥是 24 随机字节（192 bit）→ **暴力破解不可行，正常使用安全** ✅
- 但 `createKey({plainKey})` 接受任意值，且 `bootstrapFromEnv`（[:374-393](../../../src/credentials/api-keys.js#L374-L393)）用 `ADMIN_KEY` 播种 —— **用户常把它设成短口令**
- DB 文件（`output/.trae-api/trae-relay.db`，未加密整库）在同用户进程可读 → **弱 `ADMIN_KEY` 可离线还原**

**修复**：`kind=login` 的哈希改 scrypt/argon2。

---

### 🟠 P2-010 — 加密密钥与密文同目录

| 文件 | 位置 | 内容 |
|---|---|---|
| `encrypt.key` | `output/.trae-api/encrypt.key` | AES-256-GCM 主密钥（64 hex） |
| `backup.key` | `output/.trae-api/backup.key` | 备份密钥 |
| `trae-relay.db` | `output/.trae-api/trae-relay.db` | 全部账号 token（密文）+ 全部 API key（密文）+ `key_enc` 可解密副本 |

**AES-256-GCM 实现正确**（[lib/crypto.js:60-84](../../../src/lib/crypto.js#L60-L84)：随机 IV、auth tag）。但**密钥与密文只靠文件系统 ACL 隔离**，同用户任意进程可同时读到两者 → 全部上游 token 与全部 `sk-` 明文。无 DPAPI / OS keystore。

**加重**：[lib/crypto.js:29-31](../../../src/lib/crypto.js#L29-L31) `normalizeKey` 把短 key 用 `'0'` 补齐到 64 → 用户提供非 hex 的 `TRAE_API_ENCRYPT_KEY` 会**静默降级为退化密钥**而非报错。**needs confirmation**（未运行验证，但代码路径清晰）。

---

### 🟡 P2-011 — 通知渠道密钥明文存储且 API 原样返回

- `output/.trae-api/notify-settings.json` 明文存 webhook `Authorization: Bearer <token>`（已确认文件存在）
- `GET /v1/admin/notify/settings`（[routes/admin-notify.js:14-24](../../../src/routes/admin-notify.js#L14-L24)）返回 `settings.getEffective()` —— **含 `serverChanSendKey`、`telegramBotToken` 等明文**，无 mask-on-read
- 对比：备份模块把该文件列为"敏感文件"并在备份中加密（[backup.js:172-173](../../../src/jobs/backup.js#L172-L173)）—— **它认为敏感，API 却不脱敏**

**修复**：API 层对已配置的 secret 字段返回掩码占位（参考 `NotifyBackupPanel` 的 `maskHint()` 已有前端实现，但数据层没做）。

---

### 🟢 P3 — 其他

| # | 问题 | 证据 |
|---|---|---|
| P3 | `/health` 免鉴权泄露池计数、下次签到时刻、策略、运行时长 | [src/index.js:69-79](../../../src/index.js#L69-L79) |
| P3 | 上游错误响应体经 `err.message` 未脱敏进入 `traffic.jsonl` | [upstream/client.js:246-249](../../../src/upstream/client.js#L246-L249) → `logRequest({error})`。**实际泄漏取决于上游是否回显，需确认** |
| P3 | 审计日志多数行缺 `clientIp`（调用方未传 `req.ip`）；JSONL 写入完全静默失败 | [src/log/audit.js:43-58](../../../src/log/audit.js#L43-L58) |
| P3 | `apiKeyEnv` 名称无白名单 + `baseUrl` 任意 http(s) → 若登录密钥泄露，一次 `PUT /v1/admin/model-router/providers/:id` 即可把 `TRAE_API_ENCRYPT_KEY` 的值 POST 到外部服务器 | [store.js:88,92](../../../src/model-router/store.js#L88) |
| P3 | 首登密钥创建存在并发双创建（两个请求同时通过 `hasLoginKey` 检查）。后果良性（第二次会 disable 第一次），但第一个响应返回的是已失效密钥 | [api-keys.js:55-82](../../../src/routes/api-keys.js#L55-L82) |

---

## 4. ✅ 已验证安全的项（值得记录）

| 项 | 证据 |
|---|---|
| **CSP 严格** | [index.js:44-54](../../../src/index.js#L44-L54) `default-src 'self'` / `script-src 'self'` / `frame-ancestors 'none'` / `form-action 'self'`，脚本**无 unsafe-inline** |
| 安全响应头齐备 | [index.js:59-65](../../../src/index.js#L59-L65) X-Frame-Options DENY + nosniff + Referrer-Policy same-origin |
| 管理面 CSRF 免疫 | Bearer 头鉴权，浏览器跨站不自动附加 |
| 首登端点 Origin 闸门 | [api-keys.js:31-45](../../../src/routes/api-keys.js#L31-L45) 校验 `sec-fetch-site` + Origin 白名单 |
| OAuth state 防重放 | `timingSafeEqual` + 一次性消费（`POST /oauth/complete` 路径） |
| 密钥不落 URL | 前端全库无 `?key=`；仅 `Authorization` 头 |
| 前端密钥存 sessionStorage | [auth.ts:7-25](../../../web/src/shared/api/auth.ts#L7-L25)（标签页生命周期，关闭即清）—— 注：`index.js:41-42` 注释称 localStorage，**注释过时** |
| 已提交配置无明文密钥 | `model-config.json` / `model-fallback.json` / `model-router.json` grep `apiKey\|sk-\|secret\|token` → 仅 `maxTokensLimit` 与 null |
| `.gitignore` 覆盖完整 | 已验证忽略 `.env` / `output/` / `.trae-api/` / `backups/` / `*.db*` / `logs/` |
| `npm audit` 0 漏洞 | prod 86 依赖全部干净；`qs` 已 override 到 6.16.0 |
| 前端零 XSS 载体 | CSP + 无 `dangerouslySetInnerHTML` |

---

## 5. 数据库（SQLite）审计

| # | 主题 | 结论 |
|---|---|---|
| D1 | 引擎 | `node:sqlite` 的 `DatabaseSync` —— **全同步**，每次 `.run()` 阻塞整个事件循环 |
| D2 | 并发设置 | 仅 `PRAGMA busy_timeout = 5000`（[db.js:200](../../../src/credentials/db.js#L200)）；**无 `journal_mode=WAL`**（全库零命中）→ DELETE 模式下每次写取排他锁 |
| D3 | 迁移 | 无框架，靠幂等 `ensureSchema` 的 ALTER（[db.js:19-192](../../../src/credentials/db.js#L19-L192)）；有一次手写重建事务（`:100-129`），被 BEGIN/ROLLBACK 覆盖 ✅ |
| D4 | **丢失更新（P0-001）** | [store.js:206-231](../../../src/credentials/store.js#L206-L231) `update()` 全列读-改-写，无版本列、无 CAS |
| D5 | 只读接口写库 | [pool.js:725](../../../src/credentials/pool.js#L725)、`:750` 在 `explainCandidates` / `snapshot` 里对每个账号全列 UPDATE → `GET /v1/admin/runtime` 与 `GET /status` 都触发 N 次写（`/status` 在 `STATUS_PUBLIC=true` 时免鉴权） |
| D6 | 声明式 FK | 无（也未声明任何 FK，PRAGMA foreign_keys 未设）—— 对当前 schema 无影响 |

---

## 6. Security & Database 评分

| 维度 | 得分 | 说明 |
|---|---:|---|
| 鉴权设计正确性 | 80 | 密钥类型分离 + Bearer 头 + CSP 严格 + CSRF 免疫 |
| 密钥与凭据存储 | 45 | 无盐哈希 + 密钥与密文同目录 + 密钥静默降级 + notify 密钥明文回传 |
| 攻击面收敛 | 50 | OAuth 监听器注入面 + 默认无限流 + `/health` 泄露 |
| 数据库健壮性 | 45 | 无 WAL + 同步阻塞 + 丢失更新 + 只读接口写库 |
| 依赖与供应链 | 95 | 0 漏洞、6 依赖、lockfile 完整 |
| 审计与可追溯 | 40 | 后端有审计、**UI 完全不可达**；多数行缺 clientIp |
| **综合** | **55 / 100** | |

**一句话**：**鉴权骨架是健全的，密钥落盘与攻击面收敛是薄弱的。** 默认本机部署下这些都是 P2；一旦改 `HOST` 暴露，P1-004 与 P1-008 立即变成 P0。