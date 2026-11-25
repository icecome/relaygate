## 6. 分文件问题清单

按模块组织。**"已读"** = 逐行/大段精读；**"已扫"** = 全量正则扫描覆盖（危险模式已排除，逻辑缺陷未逐行核验）。表内仅列有发现或需说明的文件。

### 6.1 入口与配置

| 文件 | 覆盖 | 等级 | 问题 | 编号 |
|------|------|------|------|------|
| `src/index.js` | 已读 | 🔵 | 4xx 分支透传 `err.message` 至客户端 | L-03 |
| `src/index.js` | 已读 | ⚪ | 中间件顺序正确（json → 上下文 → CSP → 静态 → 路由 → 鉴权），`x-powered-by` 已关，CSP 无 `unsafe-*` on script | — |
| `src/config.js` | 已读 | 🔴/🔵 | `normalizeKey` 补零与非 hex 折叠（在 `lib/crypto.js`）| M-01 |
| `src/config.js` | 已读 | ⚪ | `reload()` 与初始加载 40+ 行重复 | N-03 |
| `src/config.js` | 已读 | 🔵 | `toolProtocol` 为死配置（注释已自述） | L-08 |
| `src/config.js` | 已读 | ✅ | API_KEY 与 ADMIN_KEY 同值即拒启动（`:157-159`），K-1 分域落地 | — |
| `package.json` | 已读 | 🟠 | `overrides.qs` 锁定漏洞版本；`body-parser` 有 high CVE | H-03 |

### 6.2 鉴权与访问控制

| 文件 | 覆盖 | 等级 | 问题 | 编号 |
|------|------|------|------|------|
| `src/middleware/auth.js` | 已读 | 🔵 | `isEnvLogin` 非恒定时间比较 | L-01 |
| `src/middleware/auth.js` | 已读 | 🟡 | `authenticateAdmin` 无限速、无失败审计 | M-05 |
| `src/middleware/auth.js` | 已读 | ✅ | 已移除 `?key=` 查询参数鉴权（`:30-32`），仅 Authorization/x-api-key | — |
| `src/middleware/model-access.js` | 已读 | ✅ | 平台边界收口完整：Qoder/Raccoon 独立池显式拒绝平台密钥越界（`:202-219`），判定顺序正确（先于 workbuddy 分支） | — |
| `src/auth/scope.js` | 已读 | ✅ | 资源通配匹配实现正确，无正则注入（`startsWith`/`===`，非 `RegExp`） | — |
| `src/middleware/rate-limit.js` | 已读 | ✅ | 默认 60 RPM（安全默认），有容量清理（`:67-71`），拒收落 traffic | — |
| `src/routes/api-keys.js` | 已读 | 🔵 | `label` 无长度上限 | L-05 |
| `src/routes/api-keys.js` | 已读 | ✅ | 首登端点有 Origin/`Sec-Fetch-Site` 闸门（`:37-50`）；禁止 REST 删除登录密钥（`:209-216`）；reveal 写审计 | — |
| `src/credentials/api-keys.js` | 已读 | ✅ | SHA-256 哈希鉴权 + AES 密文备份；`normalizeScopes` 白名单过滤；`ensureModelsReadScope`/`ensureInvokeScope` 迁移幂等且注释记录了事故根因 | — |

### 6.3 凭据与加密

| 文件 | 覆盖 | 等级 | 问题 | 编号 |
|------|------|------|------|------|
| `src/lib/crypto.js` | 已读 | 🟡 | `normalizeKey` 静默补零/折叠为非预期密钥 | M-01 |
| `src/lib/crypto.js` | 已读 | ✅ | AES-256-GCM + 随机 IV + authTag；密钥持久化防"重启丢密钥"；`wasKeyGenerated` 供启动熔断 | — |
| `src/credentials/transfer.js` | 已读 | 🟡 | `gunzipSync` 无输出上限 | M-03 |
| `src/credentials/transfer.js` | 已读 | ✅ | scrypt(N=16384) + AES-256-GCM + 随机 salt/iv；`MAX_ITEMS=2000`、密码长度夹紧；错误区分"密码错/文件损坏"不漏细节 | — |
| `src/jobs/backup.js` | 已读 | 🟠 | `verifyBackup` 绕过路径闸门 | **H-01** |
| `src/jobs/backup.js` | 已读 | ✅ | `resolveBackupPath` 实现正确（`path.relative` + `..` 检查 + 文件名正则 + 存在性）；`inspectBackup`/`restoreBackup` 均走闸门；恢复前自动安全快照 | — |
| `src/jobs/rotate-seed.js` | 已读 | 🟠 | 生产代码依赖 `logs/_wb-plain/` 明文 token | **H-04** |
| `src/credentials/store.js` | 已读 | ✅ | SQL 全参数化；动态 SET 子句的列名来自静态 `PATCH_COLUMNS` 白名单；乐观锁 CAS 防丢失更新；`safeTok` 剥离 token/refreshToken/apiKey/raccoonPhone/raccoonPassword/version | — |
| `src/credentials/db.js` | 已扫 | ✅ | 全部 `ALTER TABLE` 为静态 DDL 字面量；`busy_timeout=5000` | — |
| `src/lib/trae-decrypt.js` | 已扫 | ✅ | AES-128-CBC 为上游既定协议（非自选），密钥派生走 SHA-512，非安全缺陷 | — |
| `src/qoder/crypto.js` | 已读 | ✅ | Chromium os_crypt v10 + DPAPI 实现正确；经 stdin 传 base64 避免 PowerShell 解析问题；密钥长度与 tag 长度均校验 | — |

### 6.4 转发链路与协议转换

| 文件 | 覆盖 | 等级 | 问题 | 编号 |
|------|------|------|------|------|
| `src/routes/qoder.js` | 已读 | 🟠 | 对话转发缺 `keyRateLimit()` | **H-02** |
| `src/routes/qoder.js` | 已读 | 🔵 | 头注释与实现漂移 | L-08 |
| `src/routes/openai.js` | 已读 | ✅ | 虚拟模型/物理模型权限均在 `canUseModel` 收口（`:304`、`:352`）；`messages` 空数组校验；Raccoon 分派有专门注释说明边界 | — |
| `src/routes/anthropic.js` | 已扫 | ✅ | `/v1/messages` 与 `count_tokens` 无内联鉴权——由 `index.js:297` 的 `app.use(authenticate)` 统一覆盖（顺序正确：`/v1/models` 之后、404 之前） | — |
| `src/routes/responses.js` | 已读 | ✅ | tools 显式 fail-closed 拒绝（`:84-92`）；平台限制明确 | — |
| `src/model-router/dispatch.js` | 已扫 | ✅ | `safeBaseUrl` 强制 http(s)；`resolveApiKey` 仅从 env 取（明文 apiKey 已剥离，M-S6） | — |
| `src/model-router/store.js` | 已扫 | ✅ | `normalizeProvider` 剥离明文 `apiKey`；`BUILTIN_WHITELIST` 白名单防静默归一 | — |
| `src/upstream/client.js` | 已扫 | ✅ | 单一上游通道；代理仅从 env 读取 | — |
| `src/lib/upstream-error.js` | 已读 | ✅ | 客户端侧错误泛化，`PUBLIC_CODES` 白名单，不拼 `err.message`；服务端保留全量 | — |
| `src/log/traffic.js` | 已读 | 🔵 | 脱敏按**键名**匹配，值特征不识别 | L-02 |

### 6.5 会话与状态

| 文件 | 覆盖 | 等级 | 问题 | 编号 |
|------|------|------|------|------|
| `src/session/sticky.js` | 已读 | 🟡 | Map 无容量上限，攻击者可控 key 无限注入 | M-02 |
| `src/lib/sse-heartbeat.js` | 已读 | ✅ | 心跳实现完整：`unref()`、TDZ 处理、`end`/`writableEnded`/异常三路 `stop()`（原疑点已核验否定） | — |
| `src/model-router/stream-gate.js` | 已扫 | ✅ | 同上，`unref()` 在 `:145` | — |
| `src/lib/atomic-write.js` | 已读 | ✅ | 同目录临时文件 + `fsync` + `rename`，正确；失败清理临时文件 | — |
| `src/lib/settings-store.js` | 已读 | ✅ | 字段描述符 + 夹紧，写入前 `coerceForSave` 防字符串布尔污染 | — |
| `src/lib/paths.js` | 已读 | ✅ | 状态目录统一 `workspaceDir/.trae-api`，读取回退旧位置 | — |

### 6.6 通知与外部调用

| 文件 | 覆盖 | 等级 | 问题 | 编号 |
|------|------|------|------|------|
| `src/notify/index.js` | 已读 | ⚪ | Webhook URL 由管理员配置，无 SSRF 白名单——属**设计选择**（网关本就是出站代理），已在 `config.js:170` 注释说明"通用 JSON POST"。若多租户使用需加目标网段限制 | 见下 |
| `src/notify/index.js` | 已读 | ✅ | `AbortSignal.timeout(notifyTimeoutMs)` 全覆盖；ServerChan key 经 `encodeURIComponent` | — |
| `src/notify/settings.js` | 已读 | ⚪ | 渠道凭据（`serverChanSendKey`/`pushPlusToken`/`telegramBotToken`）以明文存 `notify-settings.json`，未走 `lib/crypto.js`。与账号 token 的保护口径不一致——建议纳入加密（属改进项，非缺陷：文件在 `.trae-api/`，权限受 OS 保护） | N-06 |

### 6.7 前端

| 文件 | 覆盖 | 等级 | 问题 | 编号 |
|------|------|------|------|------|
| `web/src/features/accounts/AccessKeysPage.tsx` | 已读 | 🟡 | `SecretBox` 明文无遮蔽、揭示无确认 | M-04 |
| `web/src/features/accounts/WbOauthDialog.tsx` | 已读 | 🔵 | 轮询 effect 禁用依赖检查 | L-06 |
| `web/src/shared/hooks/useAsyncData.ts` | 已读 | 🔵 | 变长依赖数组 | L-06 |
| `web/src/shared/api/auth.ts` | 已读 | 🔵 | 密钥存 `sessionStorage`（标签页生命周期），已被 CSP `script-src 'self'` + `X-Frame-Options: DENY` 缓解；同源 XSS 仍可读取——因全仓无 XSS 面，风险可接受 | — |
| `web/src/features/accounts/CredentialsPage.tsx` | 已读 | 🔵 | 1119 行单文件 | L-07 |
| `web/src/features/ops/OpsPage.tsx` | 已扫 | 🔵 | 1732 行单文件 | L-07 |
| `web/src/shared/api/admin.ts` | 已扫 | ⚪ | 876 行单文件承载全部管理 API | N-04 |
| `web/src/**` | 已扫 | ✅ | 无 `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`document.write`；唯一动态 `href` 配 `rel="noreferrer noopener"` | — |

### 6.8 运维脚本

| 文件 | 覆盖 | 等级 | 问题 | 编号 |
|------|------|------|------|------|
| `scripts/verify/verify-review-fixes.js` | 已扫 | 🔵 | 疑似真实手机号 + 密码字面量 | L-04 |
| `scripts/wb-decrypt-auth.js` | 已读 | 🟠 | 明文 token 默认落盘 `logs/_wb-plain`（H-04 的产出方） | **H-04** |
| `scripts/ops/*`、`scripts/verify/*` | 已扫 | ⚪ | 未发现硬编码生产密钥；命令调用均为数组传参 | — |
| `scripts/probes/*`（79 个） | 已扫 | ⚪ | 一次性探针，含大量 http 样板与硬编码上游路径。**不建议投入重构**（用完即弃），但建议在目录 README 标注"非生产代码，不要被 src/ 引用" | N-07 |

---
