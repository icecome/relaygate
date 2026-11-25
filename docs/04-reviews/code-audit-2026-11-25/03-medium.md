## 3. 中危问题（M-01 ~ M-07）

---

### M-01 加密密钥规范化：非十六进制密钥被静默折叠为零密钥

| 项 | 内容 |
|----|------|
| **文件** | `src/lib/crypto.js:44-47` |
| **等级** | 🟡 中危 |
| **类型** | 加密实现缺陷（CWE-1188 / CWE-321） |

**问题描述**

```js
function normalizeKey(key) {
  if (key.length < 64) key = key.padEnd(64, '0');
  return Buffer.from(key.substring(0, 64), 'hex');
}
```

`TRAE_API_ENCRYPT_KEY` 的环境变量约定是 **64 位十六进制**（32 字节），但代码**不校验字符集**。实测（Node v24）：

```
normalizeKey('short')        → Buffer 长度 0
normalizeKey('z'.repeat(64)) → Buffer 长度 0
normalizeKey('ab'.repeat(32))→ Buffer 长度 32   ← 唯一合法形态
```

两个后果：

1. **`Buffer.from(..., 'hex')` 对非法字符静默截断**，返回长度 0 的 Buffer。随后 `createCipheriv('aes-256-gcm', <0 字节>, iv)` 抛 `Invalid key length`。用户若设了 `TRAE_API_ENCRYPT_KEY=my-secret-password`（一个很自然的误解），得到的是启动期一个不含"密钥格式错误"语义的底层异常。`startup-checks.js` 的 `encryptKey` 检查会捕获为 fatal，方向正确，但文案无法指向真实原因。
2. **`padEnd(64,'0')` 使短密钥被补零**：`TRAE_API_ENCRYPT_KEY=abc` 与 `abc0000...` 等价，熵被悄悄降低。用户以为设了 3 字符密码有保护，实际强度远低于提示。

**影响** 配置错误时安全边界不明；密钥熵被静默削减。不构成直接可利用漏洞（需本地配置权限），故为中危。

**修复建议**

```js
function normalizeKey(key) {
  const s = String(key).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error(
      `${KEY_ENV_VAR} 必须是 64 位十六进制（32 字节），当前长度 ${s.length}、含非法字符` +
      `；可执行 node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 生成`
    );
  }
  return Buffer.from(s, 'hex');
}
```

移除 `padEnd` 补零逻辑——静默降级比明确失败更危险，这与本项目 `startup-checks.js` 自己确立的"把静默降级变成明确失败"原则一致。

---

### M-02 会话粘性 Map 无容量上限，攻击者可用请求头无限注入

| 项 | 内容 |
|----|------|
| **文件** | `src/session/sticky.js:9,18-27,57-60` |
| **等级** | 🟡 中危 |
| **类型** | 内存耗尽（CWE-770） |

**问题描述**

```js
const map = new Map();                       // :9  无上限

function bind(stickyKey, accountId) {
  ...
  map.set(String(stickyKey), { ... });       // :22 无长度/无数量约束
}

function stickyKeyFromRequest(req) {
  const h = req.headers || {};
  const explicit = h['x-sticky-key'] || h['x-session-id'] || h['x-conversation-id'];
  if (explicit) return String(explicit);     // :60 任意长度的攻击者输入直接成为 key
```

`prune()`（`:11-16`）只在 `bind`/`lookup` 时按 TTL 清理，**没有容量上限**。持有合法 access key 的攻击者可发送海量请求，每次带不同的 `x-sticky-key`（或超长 key），在 1 小时 TTL 内把 `map` 撑到任意大小。每次请求约新增一个 entry + 一个长字符串。

**影响** 进程内存持续增长直至 OOM。对比 `middleware/rate-limit.js:67-71` 已有 `windows.size > 5000` 的容量清理，说明团队对此类内存表已有既定防护模式，此处遗漏。因需持有合法密钥，定级中危。

**修复建议**

1. 对 sticky key 做长度截断（如 128 字符）与哈希归一：`nodeCrypto.createHash('sha256').update(s).digest('hex').slice(0,32)`，既限长又避免敏感 session id 明文驻留内存。
2. 加容量上限，超限时淘汰最旧 entry：

```js
const MAX_ENTRIES = 10000;
function bind(k, accountId) {
  if (map.size >= MAX_ENTRIES) {
    // Map 保持插入序，删第一个即最旧
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  ...
}
```

---

### M-03 导入文件解压无上限（解压炸弹）

| 项 | 内容 |
|----|------|
| **文件** | `src/credentials/transfer.js:110-119` |
| **等级** | 🟡 中危 |
| **类型** | 解压炸弹 / 资源耗尽（CWE-409） |

**问题描述**

```js
let compressed;
try {
  const decipher = crypto.createDecipheriv('aes-256-gcm', scryptKey(...), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  compressed = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
} catch (_) { throw new TransferInputError('密码错误或导出文件已损坏'); }
let payload;
try {
  payload = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));   // :118  无输出上限
} catch (_) { throw new TransferInputError('导出数据无法解析或已损坏'); }
```

`gunzipSync` 会把解压结果**完整**读入内存，无大小上限。虽然输入受 `express.json` 的 16 MiB 限制，但 GCM 密文解出后经 gzip 的膨胀比可达 1000:1 以上——一个几 MB 的合法加密信封可解出数 GB。

**影响** 持有管理密钥者可让进程 OOM。同模块已有 `MAX_ITEMS = 2000`（`:39`）与密码长度上限（`:36`），说明输入边界是既定关注点，此处是遗漏。因需管理权限，定危中危。

**修复建议**

用流式解压并限制输出字节，或用 `zlib.gunzipSync(buf, { maxOutputLength: N })`（Node 15+ 支持）：

```js
const MAX_UNPACKED = 64 * 1024 * 1024;   // 与 MAX_ITEMS 的实际体积匹配
payload = JSON.parse(zlib.gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED }).toString('utf8'));
```

超限时 `zlib` 抛 `ERR_BUFFER_TOO_LARGE`，在现有 `catch` 中转为 `TransferInputError('导出数据超出体积上限')`。

---

### M-04 明文密钥在 DOM 中无遮蔽渲染，揭示端点无二次确认

| 项 | 内容 |
|----|------|
| **文件** | `web/src/features/accounts/AccessKeysPage.tsx:66-70`、`:183-190`、`:232-241` |
| **等级** | 🟡 中危 |
| **类型** | 敏感信息暴露于界面（CWE-522 / CWE-200） |

**问题描述**

```tsx
// :66
function SecretBox({ value }: { value: string }) {
  return (
    <div className="code-block select-all text-[13px]">{value}</div>
  );
}
```

`SecretBox` 把完整明文密钥直接渲染为可选中的文本，无掩码、无超时自动隐藏。"查看明文"按钮（`:506-509`）点击后立即调用 `revealAccessKey` 并渲染，无二次确认。

后端侧的设计意图是正确的——`api-keys.js:250-253` 注释写明"界面不展示明文，仅写入剪贴板"，并在 `:268-274` 写了审计日志 `key.reveal`。但前端实现与该意图相悖：明文确实展示在界面上，且 `revealLoginKey`（`:232`）可读取**登录密钥**明文，等于把管理面凭据暴露在屏幕上。

**影响** 肩窥、屏幕共享、截图、浏览器扩展均可直接获取凭据。虽已有审计日志可追溯"谁查看了"，但泄露已经发生。定级中危（需已登录管理面）。

**修复建议**

1. `SecretBox` 默认掩码（`sk-••••••••`），点击"显示"后限时 30 秒自动回掩码。
2. 揭示前加确认弹窗，明示"该操作已记入审计日志"。
3. 复制成功后立即清除 state，不长期保留明文于 React 树中。

---

### M-05 管理面鉴权无失败限速，且失败不入审计日志

| 项 | 内容 |
|----|------|
| **文件** | `src/middleware/auth.js:70-84`、`:35-41` |
| **等级** | 🟡 中危 |
| **类型** | 认证暴力破解防护缺失（CWE-307） |

**问题描述**

`authenticateAdmin` 对失败请求直接返回 401，**无任何失败计数或退避**：

```js
function authenticateAdmin(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json(...);
  const rec = apiKeys.verifyLoginKey(token);
  if (rec) { ...; return next(); }
  if (isEnvLogin(token)) return next();
  return res.status(401).json({ error: { message: 'Invalid login key', type: 'auth_error' } });  // 无限试
}
```

对比：转发面有 `keyRateLimit`（默认 60 RPM），但**管理面完全没有**。同时 `middleware/auth.js` 全文**未调用 `log/audit.js`**——失败的管理登录尝试只写了一条 traffic（`logReject`，且仅在 `authenticate`/`authenticateAny` 里，`authenticateAdmin` 连这个都没有），审计链在管理面是断的。

`isEnvLogin` 用 `token === adminKey`（`:39`）做明文比较，非 `crypto.timingSafeEqual`（见 L-01）。

**影响** 攻击者可对管理面无限次猜测登录密钥。`genPlainKey` 生成 `sk-admin-` + 24 字节随机（192 bit），暴力破解在数学上不可行，**故实际风险有限**——但缺少限速意味着：(a) 无法阻止针对弱自定义密钥（`createKey({plainKey})` 允许任意值，含 `bootstrapFromEnv` 从 env 读取）的字典攻击；(b) 无失败审计，事后无法发现探测行为。定级中危。

**修复建议**

1. 复用 `keyRateLimit` 思路，对管理面加**按 IP + 全局**的失败计数与指数退避（如 5 次失败后锁 60s，复用 `rate-limiter` 的滑窗结构）。
2. `authenticateAdmin` 失败时调用 `audit({action:'auth.admin_fail', result:'deny', clientIp, userAgent})`。
3. `isEnvLogin` 改用 `crypto.timingSafeEqual`（见 L-01）。
4. 对 `createKey({plainKey})` 增加最小熵校验（长度 ≥ 32 且非纯数字/字典串），杜绝弱自定义密钥。

---

### M-06 ~~SSE 心跳定时器泄漏~~ —— 已核验为**不成立**，改列为提示 N-06

| 项 | 内容 |
|----|------|
| **文件** | `src/lib/sse-heartbeat.js:113-132`、`src/model-router/stream-gate.js:130-145` |
| **原判等级** | 🟡 中危（拟报"定时器泄漏"） |
| **复核结论** | ⚪ **不成立**，原判断错误，已撤回 |

**复核过程**

初判怀疑 `lib/sse-heartbeat.js` 的 `setInterval` 未 `unref()`，且 `stream-gate.js:145` 有 `unref()` 形成对比。逐行核验后，两处**都正确调用了 `unref()`**：

```js
// src/lib/sse-heartbeat.js:130-132
  }, intervalMs);
  // 不阻止进程退出（与 stream-gate 的处理一致）。
  if (timer.unref) timer.unref();
```

且 `stop()` 路径完整：`res.end` 被包装并在 `:108-111` 调 `stop()`；定时器每拍检查 `res.writableEnded`（`:115`）与 `stopped`（`:114`）；写出异常时 `catch` 内 `stop()`（`:128`）。`timer` 的 TDZ 问题也在 `:90-92` 显式处理并注释。

**结论**：此处实现质量高于一般水平，**无可报告缺陷**。保留本条是为了给出「已核验否定」的记录，避免后续复审重复投入。

> ⚠️ **本节不从"中危清单"移除编号**，而是原地标注为不成立，以保证 M-01~M-07 编号在正文与汇总表、附录中一致。实际中危数为 **6**（M-01、M-02、M-03、M-04、M-05、M-07）。

---

### M-07 `verifyBackup` 之外的错误回显面：多个路由直接回 `err.message`

| 项 | 内容 |
|----|------|
| **文件** | `src/routes/admin-jobs.js:132-133`、`:143-144`、`:163-165`；`src/routes/admin-security.js` 等 |
| **等级** | 🟡 中危 |
| **类型** | 敏感信息泄露于错误消息（CWE-209） |

**问题描述**

多数管理路由直接把内部异常文本回给客户端：

```js
// src/routes/admin-jobs.js:132
} catch (e) {
  res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
}
```

管理面已鉴权，故风险可控；但结合 H-01（路径回显）构成实际泄露链。另有 `src/index.js:333` 的全局错误处理器会把 `err.message` 前 300 字符回给**转发面**客户端：

```js
error: { message: `${hint} 原始原因：${String(err.message).slice(0, 300)}`, ... }
```

该分支仅限 `err.type && 4xx`（body-parser 解析错误），`err.message` 是本机文案，注释已说明"不含上游内容"，判断正确。但这是一处**需要持续守住**的边界——一旦某天有新的 `err.type` 落入 `4xx` 区间且消息含用户输入，就会外泄。

**修复建议**

1. 管理面统一走一个 `safeErrorMessage(e)`：对已知业务错误（`TransferInputError` 等带 `status` 的）回原文，其余回固定串 + 服务端日志记录 traceId。
2. 全局 4xx 分支改为按 `err.type` 白名单映射到固定文案，不透传 `err.message`（当前 `entity.parse.failed` 的 `err.message` 会含请求体片段）。

---
