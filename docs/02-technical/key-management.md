# RelayGate 密钥治理规范（K 系列）

> 适用版本：v3.x（K-1 权限分离改造后）
> 上游账号凭据（Trae / WorkBuddy token）**不属于本项目核心凭据体系**，本项目仅承担其获取与加密存储，见 [§6 边界](#6-边界上游账号凭据)。

## 1. 密钥分域模型（K-1 权限分离）

RelayGate 的凭据分两个安全域，**域间互不通用**：

| 域 | 凭据 | 用途 | 鉴权入口 |
|---|---|---|---|
| **管理域** | DB 登录密钥（`kind=login`，前缀 `sk-admin-`）或 env `ADMIN_KEY`（过渡） | 管理面板、`/v1/admin/*`、`/v1/api-keys/*`、`/v1/credentials/*` | `authenticateAdmin` |
| **转发域** | DB 访问密钥（`kind=access`，前缀 `sk-`） | `/v1/chat/completions`、`/v1/messages`、`/v1/responses`、`/v1/models` | `authenticate` / `authenticateAny` |

强制约束（`src/config.js`）：

- env `API_KEY` 与 `ADMIN_KEY` **同值时服务拒绝启动**（配置事故防线）。
- `API_KEY` 不再参与运行期鉴权，仅为「库内无访问密钥」时的引导种子。
- 管理面 **不再接受** `API_KEY` 登录（历史过渡行为已移除）。

### env 变量职责（全部可选）

| 变量 | 角色 | 生效条件 |
|---|---|---|
| `ADMIN_KEY` | 引导创建登录密钥 | 库内无启用 login key 时，启动自动落库 |
| `API_KEY` | 引导创建 trae 平台访问密钥 | 库内无启用 access key 时 |
| `WORKBUDDY_API_KEY` | 引导创建 workbuddy 平台访问密钥 | 同上 |
| `UNIVERSAL_API_KEY` | 引导创建 platform=all 通用密钥 | 同上 |

**推荐做法**：首次部署配置 `ADMIN_KEY`（+`API_KEY` 可选）→ 启动自动落库 → 确认面板可登录后从 `.env` 移除这些值。此后密钥全生命周期在 DB 内管理。

## 2. 访问密钥：权限范围与使用场景

三维权限模型（`src/credentials/api-keys.js` + `src/auth/scope.js` + `src/middleware/model-access.js`）：

1. **platform**：`trae` | `workbuddy` | `all`
   - 平台密钥只调本平台模型；`all`（通用）可调虚拟模型 + 全部平台 + 通用 Provider。
2. **scopes**：`models:read`（列表）、`models:invoke`（调用）、`router:read`、`router:invoke`、`admin:keys`、`admin:catalog`
   - 默认值：`all` 密钥四项全给；平台密钥 `["models:read","models:invoke"]`（K-3 起）。
   - `/v1/models` 对访问密钥强制 `models:read`（K-2 关卡，`requireKeyScope`）。
3. **resources ACL**：`*` / `model:trae/*` / `model:workbuddy/*` / `model:virtual:vm/x` / `provider/<id>/*`，支持前缀通配。

附加控制：`rpmLimit`（密钥级 RPM 滑窗限流）、`expiresAt`（有效期）。

## 3. 生命周期机制

`创建 → 使用 → 轮换(双密钥窗口) → 暂停/撤销 → 过期清扫`

| 环节 | 机制 | 位置 |
|---|---|---|
| 创建 | 明文仅返回一次；SHA-256 哈希（鉴权）+ AES-256-GCM 密文（复制回显）双写 | `api-keys.js createKey` |
| 轮换 | `POST /v1/api-keys/:id/rotate`，新密钥继承属性，旧密钥宽限期（默认 24h）后失效 | `rotateKey` |
| 暂停 | `PATCH /v1/api-keys/:id` `enabled=false` | `updateKey` |
| 撤销 | `POST /v1/api-keys/:id/revoke`，立即失效不可恢复，保留行审计 | `revokeKey` |
| 过期 | `sweepExpired` 由调度器每 15 分钟执行；`isUsableRow` 鉴权侧双保险 | `scheduler.js` |
| TTL | 默认 `KEY_DEFAULT_TTL_DAYS`（90 天），`expiresAt:null` 永久 | `normalizeExpires` |
| scope 迁移 | 启动时 `ensureModelsReadScope` 幂等补齐存量密钥 | `index.js` 启动段 |

登录密钥特殊规则：全库至多一把启用；无过期；REST 禁止删除（防锁死），轮换走 CLI `node scripts/login-key.js reset` 或面板重置接口。

## 4. 审计（K-4）

所有高危操作落 `audit_log` 表 + `logs/<date>/audit.jsonl`：

```
key.create / key.update / key.rotate / key.revoke / key.reset
key.setup（首登创建登录密钥）
key.reveal（明文回显，高危读）
```

查询：`GET /v1/admin/audit?action=key.reveal`。记录含 `actor_key_id`、`client_ip`、`user_agent`、`meta`。

## 5. 存储与加密

- **DB**：`{WORKSPACE_DIR}/.trae-api/trae-relay.db` — `api_keys`（`key_hash` UNIQUE + `key_enc`）、`accounts`（`token_enc`/`refresh_token_enc`）、`audit_log`。
- **凭据加密主密钥**：`TRAE_API_ENCRYPT_KEY`（64 hex）或自动生成 `.trae-api/encrypt.key`（AES-256-GCM 根密钥；存在旧文件时绝不重新生成，防历史密文不可逆丢失）。
- **备份密钥**：`TRAE_BACKUP_PASSPHRASE`（≥16 字符）或 `.trae-api/backup.key`；备份文件 AES-256-GCM 加密 + sha256 校验和。
- **脱敏口径**：列表仅显示 `sk-…后4位` hint；日志统一 `maskSecret`（首6+尾4）；`?key=` 查询参数已禁用（n-13）。

## 6. 边界：上游账号凭据

Trae / WorkBuddy 的 `accessToken`/`refreshToken` 是**上游服务的账号登录态**，不是本项目签发的凭据：

- **获取**：OAuth 授权流程、桌面端登录态读取、手动导入（`credentials/import.js`、`credentials/oauth.js`）。
- **存储**：AES-256-GCM 加密落 `accounts` 表，列表接口一律脱敏（`safeTok`）。
- **续期**：自动刷新（提前 30 分钟 / 定时保活），对管理员透明。
- **不纳入**访问密钥/登录密钥的 scope、轮换、审计体系；无法通过 `/v1/api-keys` 管理，仅 `/v1/credentials`（管理域）可操作。

## 7. 运维手册

### 首次部署

```bash
# .env: ADMIN_KEY=<随机值>
node scripts/login-key.js list     # 确认 bootstrap-login 已创建
# 面板登录后，在「访问密钥」创建业务密钥，然后从 .env 移除 ADMIN_KEY
```

### 轮换登录密钥

```bash
node scripts/login-key.js reset    # 旧密钥立即全部失效，明文走 stderr 仅显示一次
```

面板内亦可重置：「访问密钥 → 登录密钥 → 重置登录密钥」。后端返回的一次性明文会在面板显示，
同时当前会话自动切换到新密钥（不会退出登录）；「查看明文」可按密文备份再次取回。
若在 CLI 重置后仍停留在面板，下一次管理面请求会 401 并回到首登引导，需粘贴新密钥。

### 轮换访问密钥（不停服）

```bash
curl -X POST /v1/api-keys/<id>/rotate -H "Authorization: Bearer <login-key>" -d '{"graceMs":86400000}'
# 客户端切换新密钥 → 确认流量 → POST /<旧id>/revoke
```

### 应急

- 密钥泄露：立即 `revoke`（访问密钥）或 `reset`（登录密钥）。
- 忘记登录密钥且 CLI 不可用：删除 DB 中 `kind='login'` 行后走面板首登 setup（仅限本机）。
- 同值自检：启动日志出现 `API_KEY 与 ADMIN_KEY 同值` 即配置事故，服务拒绝启动。
