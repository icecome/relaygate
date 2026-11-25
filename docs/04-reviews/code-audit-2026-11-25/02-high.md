## 2. 高危问题（H-01 ~ H-04）

---

### H-01 备份文件校验端点存在任意文件读取（路径校验被绕过）

| 项 | 内容 |
|----|------|
| **文件** | `src/routes/admin-jobs.js:127-135`、`src/jobs/backup.js:303-314` |
| **等级** | 🟠 高危 |
| **类型** | 路径遍历 / 任意文件读取（CWE-22） |

**问题描述**

`backup.js` 为备份文件访问提供了路径闸门 `resolveBackupPath()`（`:321-336`），它把路径限制在备份目录内、校验文件名正则、检查存在性。`inspectBackup`（`:340`）与 `restoreBackup`（`:399`）都正确调用了它。

但 `verifyBackup(filePath)` **直接 `fs.readFileSync(filePath)`，完全绕过闸门**：

```js
// src/jobs/backup.js:303
function verifyBackup(filePath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));   // ← 无路径约束
```

而路由把用户输入原样传入：

```js
// src/routes/admin-jobs.js:129-131
const p = String((req.body && req.body.path) || (req.query && req.query.path) || '');
if (!p) return res.status(400)...;
res.json({ ok: true, ...require('../jobs/backup').verifyBackup(p) });   // ← 未走 resolveBackupPath
```

**影响**

- 已鉴权管理员可读取**任意可读文件**（`GET /v1/admin/backup/inspect` 有闸门，`POST /v1/admin/backup/verify` 没有）。
- 泄露通道：错误回显。`fs` 读取失败时 `e.message` 原样返回（`:312` `'解析失败: ' + e.message`），含绝对路径与 errno；JSON 解析失败时 Node 会回显内容前缀。实测 Node v24：

  ```
  JSON.parse('SUPER_SECRET_TOKEN_abcdef123456')
  → Unexpected token 'S', "SUPER_SECR"... is not valid JSON
  ```

  故读取任意非 JSON 文件（如 `output/.trae-api/encrypt.key`）可回显其**前若干字节**。
- 因该端点限管理员，定级为高危而非严重。

**修复建议**

在 `verifyBackup` 内部复用闸门，而非依赖调用方自觉（否则下一个调用方还会漏）：

```js
function verifyBackup(filePath) {
  let full;
  try { full = resolveBackupPath(filePath); }        // 统一入口校验
  catch (e) { return { ok: false, reason: e.message }; }
  try {
    const manifest = JSON.parse(fs.readFileSync(full, 'utf-8'));
    ...
  } catch (e) {
    return { ok: false, reason: '解析失败或文件损坏' };   // 不回显 e.message
  }
}
```

同时把 `:312` 的错误文案改为固定串，避免路径与内容外泄。

---

### H-02 Qoder 对话转发端点缺失限流（代码注释声明的防护未实现）

| 项 | 内容 |
|----|------|
| **文件** | `src/routes/qoder.js:6-9`（注释声明）、`:418`（实际实现） |
| **等级** | 🟠 高危 |
| **类型** | 资源耗尽 / 缺失速率限制（CWE-770） |

**问题描述**

该文件头注释明确声明：

```
*   - 对话转发（/chat/completions）：转发面鉴权（authenticate + keyRateLimit），
*     与 /v1/chat/completions 同构。
```

实际实现只有 `authenticate`，**没有 `keyRateLimit()`**：

```js
// src/routes/qoder.js:418
router.post('/chat/completions', authenticate, async (req, res) => {
```

对比同构的 Raccoon 端点，后者两个中间件都在：

```js
// src/routes/raccoon.js:545
router.post('/chat/completions', authenticate, keyRateLimit(), async (req, res) => {
```

且 `qoder.js` 的 import 区（`:34`）只引入了 `authenticateAdmin, authenticate`，**根本没有引入 `keyRateLimit`**——注释与实现已完全脱节。

**影响**

`middleware/rate-limit.js` 的注释本身说明了这个控制的必要性：

> 本转发面消耗的是真实账号积分（签到攒的、不可再生），任何持钥者（或拿到密钥的第三方）都能把整个池子烧穿

Qoder 端点直接消耗 Qoder 账号积分，却不受 `KEY_DEFAULT_RPM`（默认 60）约束。任何持有合法 access key 的一方（含密钥泄露后的攻击者）都可无限速刷，烧穿 Qoder 额度并持续占用上游连接。同时 `store.list()` 每请求全表扫描，高频请求会阻塞事件循环。

**修复建议**

```js
const { keyRateLimit } = require('../middleware/rate-limit');
router.post('/chat/completions', authenticate, keyRateLimit(), async (req, res) => {
```

建议一并审计**所有**转发入口的限流装配是否完整，并在测试中加一条"每个 `/chat/completions` 路由都必须挂 `keyRateLimit`"的守门断言（可参考 `src/test/wiring.test.js` 的既有做法），防止再来一次同类遗漏。

---

### H-03 依赖存在已知漏洞，且 `qs` 被 override 钉在受影响版本

| 项 | 内容 |
|----|------|
| **文件** | `package.json:51-61`、`package-lock.json` |
| **等级** | 🟠 高危 |
| **类型** | 使用含已知漏洞的组件（CWE-1395 / CWE-1104） |

**问题描述**

`npm audit` 实测结果（2026-11-25，当前安装版本）：

| 组件 | 版本 | 等级 | 漏洞 | 受影响区间 |
|------|------|------|------|-----------|
| `body-parser` | 1.20.8 | **high** | 压缩请求体尾部字节致 DoS（GHSA-27r3-jxmh-p828，CWE-248） | `<=1.20.8` |
| `qs` | 6.16.0 | moderate | `arrayFormat:'comma'` 下不可调用 `toString` 致未捕获 TypeError（GHSA-6pq8-jhm2-2vcw） | `6.7.0 - 6.16.0` |
| `express` | 4.22.1 | moderate | 经 `qs` 传导 | `4.17.0 - 4.22.2` |
| `ip-address` | 10.7.3 | moderate | `Address6` 区号标识二次时间匹配（CWE-1333） | `<=10.7.3` |

关键问题在 `package.json:59-61`：

```json
"overrides": {
  "qs": "6.16.0"
}
```

这个 override 把 `qs` **强制锁定在 6.16.0**，而该版本正处于受影响区间 `6.7.0 - 6.16.0`。也就是说，这条 override 是**把依赖钉在了漏洞版本上**，并且会阻断 `npm audit fix` 的正常升级路径。

`body-parser` 的 DoS 尤为值得注意：本项目在 `src/index.js:68` 显式挂了 `express.json({ limit: config.maxBodyBytes })`，并且专门为 `entity.too.large` 写了 413 处理（`:69-111`），说明请求体边界是团队明确关注的方向；而该 CVE 恰好是"压缩请求体之后的尾部字节"绕过体积检查，属于同一攻击面的已知缺口。

**修复建议**

1. 升级 `body-parser` 至 `>=1.20.9`（`npm audit` 标记 `fixAvailable: true`）。
2. 移除 `qs` 的 override（当前 override 无版本收益，只带来锁定风险），或改为 `"qs": "^6.16.1"`。
3. 升级 `express` 至 `>=4.22.3`（或 5.1.0+）。
4. 在 CI 中加 `npm audit --audit-level=high` 门禁，防止回归。
5. 若无法立即升级 `body-parser`，可临时在 `express.json` 前加 `Content-Encoding` 白名单拒绝（本项目本就只支持 UTF-8 无压缩，见 `src/index.js:328` 的 `UNSUPPORTED_CHARSET` 分支），可实质消除该 CVE 的触发条件。

---

### H-04 生产代码反向依赖 `logs/_wb-plain/` 下的明文 token 缓存

| 项 | 内容 |
|----|------|
| **文件** | `src/jobs/rotate-seed.js:110-130`；产出方 `scripts/wb-decrypt-auth.js:117-118` |
| **等级** | 🟠 高危 |
| **类型** | 敏感数据以明文落盘（CWE-312） |

**问题描述**

`scripts/wb-decrypt-auth.js` 把 WorkBuddy 客户端的 at-rest 加密凭据解密后，**以明文 JSON 写入 `logs/_wb-plain/`**：

```js
// scripts/wb-decrypt-auth.js:117-118
const out = path.join(OUT_DIR, `workbuddy-desktop.info.${uid || 'unknown'}`);
fs.writeFileSync(out, JSON.stringify(plain, null, 2), 'utf8');
```

实测该目录下现存 8 个文件，每个都含完整的 `auth.accessToken`（1361 字符）与 `auth.refreshToken`（700 字符），以及 `account.phoneNumber`（PII，虽在文件中已部分打码但 `uin` 完整）。

问题在于**生产代码把这份明文缓存当成了正常运行时的数据源**：

```js
// src/jobs/rotate-seed.js:110-130
 *  优先级：解密明文缓存（logs/_wb-plain，字段最全：uin/sessionState/domain 等）
 *        → 客户端备份 → null（回落到最小骨架）
function pickSkeleton(uid) {
  const plainDir = path.join(__dirname, '..', '..', 'logs', '_wb-plain');
  ...
      const hit = fs.readdirSync(plainDir).find((f) => f.includes(uid));
      if (hit) {
        const j = JSON.parse(fs.readFileSync(path.join(plainDir, hit), 'utf8'));
        if (j && j.account && j.account.uid === uid) return j;
```

**影响**

1. **明文凭据长期驻留磁盘**，且生命周期由脚本产出决定，不受任何轮换/清理策略约束（`logs/` 仅有 `log/retention.js` 的按天清理，而 `_wb-plain` 不是按天目录，实测文件停留在 10 月 25 日仍未被清理）。
2. **提权面**：网关进程（可能以 LocalSystem 运行，见 `rotate-accounts.js` 注释）与任何能读 `logs/` 的本机用户都能拿到可直接使用的 refreshToken。
3. **架构倒置**：生产逻辑依赖运维脚本的**中间产物**。若用户从未运行 `wb-decrypt-auth.js`，该分支静默失效并回落到次优骨架，行为随"是否跑过某个脚本"而变——这正是 `rotate-seed.js:113-118` 注释里记录的踩坑史（"字段越滚越少，客户端 hasAccessToken=false"）的根源。
4. 该目录虽被 `.gitignore:28`（`logs/`）覆盖、未进版本库，但**不进库不等于不泄露**。

**修复建议**

1. **短期（立即）：** 删除 `logs/_wb-plain/` 并轮换其中全部账号的 refreshToken（这些 token 已在磁盘明文存在超过一个月，应视为已泄露）。加一条启动期或 CI 检查，发现该目录存在即告警。
2. **中期：** 把"权威骨架"改为从 `store` 的加密字段派生（`store.get(id)` 已能解密 `devices`/`fingerprint`），删除 `rotate-seed.js:120-130` 的明文分支。骨架字段不足的问题应通过**扩展加密存储的字段**解决，而不是读明文文件。
3. **长期：** `scripts/wb-decrypt-auth.js` 的默认输出目录改为 `output/.trae-api/`（受现有加密与 gitignore 保护），并要求显式 `--out` 才落盘，输出后自动提示清理。

---

