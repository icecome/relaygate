# P1-008 — 转发面默认无限流

| 字段 | 值 |
|---|---|
| **Priority** | P1（默认部署 P2；密钥外泄或对外暴露时 **P0**） |
| **Category** | 安全 |
| **Labels** | `security`, `p1`, `backend`, `rate-limit` |
| **Difficulty** | 极低（10 分钟） |
| **Risk** | 极低 |
| **来源** | product-professor full audit 2026-10-10（evidence-verifier 已复核） |

---

## Evidence

[src/middleware/rate-limit.js:11-17](../../../../src/middleware/rate-limit.js#L11-L17)（已实读复核）：

```js
function maxRpmFor(keyRec) {
  if (keyRec && keyRec.rpmLimit != null && Number.isFinite(Number(keyRec.rpmLimit))) {
    return Math.max(1, Math.trunc(Number(keyRec.rpmLimit)));
  }
  const env = Number(process.env.KEY_DEFAULT_RPM || 0);
  return Number.isFinite(env) && env > 0 ? Math.trunc(env) : 0;   // 0 = 不限
}
```

**已核实**：
1. `.env.example` **未定义 `KEY_DEFAULT_RPM`** → 默认 `0 = 不限`
2. 密钥创建时前端从不发送 `rpm_limit`（[AccessKeysPage.tsx:109](../../../../web/src/features/accounts/AccessKeysPage.tsx#L109) 只发 `{label}`；后端 [api-keys.js:111-146](../../../../src/routes/api-keys.js#L111-L146) 的 rowToKey 中 `rpmLimit` 默认 null）→ **实际部署中每把密钥都是"不限"**
3. 限流桶按 `req.apiKeyId`（[rate-limit.js:19-50](../../../../src/middleware/rate-limit.js#L19-L50)）——**按密钥而非按 IP**，无全局/IP 兜底限制
4. [index.js:39](../../../../src/index.js#L39) `express.json({ limit: '10mb' })` —— 单请求体上限 10MB

### 组合后果

一个持有任意一把访问密钥的客户端（或拿到密钥的任何第三方）可以：
- 以无限 RPM 打 `/v1/chat/completions`
- 每个请求带最多 10MB 的消息体
- **烧光池内全部账号的真实积分额度**（这些额度是靠每日签到攒的，烧掉不可恢复）

且该流量同步阻塞事件循环（见 P2-008 `store.list()` 全表读 ×4/请求）——**一个恶意客户端可以拖死整个网关**。

---

## Why it matters

这个网关的价值全部建立在"免费额度"上。**额度是该系统唯一不可再生的资源**，而它对持钥者完全敞开。

修复成本 10 分钟（一行 env + 一行默认值），不修的期望损失是"某天早上醒来池子空了"。

另外注意： OWASP API4:2023 (Unrestricted Resource Consumption) 正是这个文件头注释里引用的标准——**代码自己声称对齐的标准，默认值却违反了它**。

---

## Expected behavior

- 未显式配置 `rpm_limit` 的密钥，使用一个**保守的全局默认**（建议 60 RPM）。
- `.env.example` 记录该默认值与调整方法。
- 存在一个**进程级/IP 级**的兜底上限，防止单客户端占满。

---

## Acceptance criteria

1. `.env.example` 包含 `KEY_DEFAULT_RPM=60` 及注释。
2. `rate-limit.js` 的 fallback 从 `0` 改为 `60`（或保持 0 但在启动时若未配置则打警告）。
3. 新增测试：未设 `rpm_limit` 的密钥在 1 分钟内第 61 次请求被 429。
4. 现有 288 断言全部通过。
5. `.env.example` 中 `STATUS_PUBLIC` 的注释提醒：公开 `/status` 前先设 `KEY_DEFAULT_RPM`。

---

## Implementation notes

1. **默认值选择**：60 RPM（每秒 1 次）对单人 IDE 使用绰绰有余；批量任务走内部调度不走访问密钥。
2. **兜底限流**（可选，第二优先）：在 `keyRateLimit` 之外加一个按 IP 的粗限流（如 240 RPM/IP），防止"多把密钥绕过单钥限制"。实现上注意不要把 `127.0.0.1` 上的正常多客户端误伤——单人场景下所有流量同 IP，**若启用 IP 限流需把默认值设得足够高或提供 env 关闭**。推荐：默认只做按密钥限流，IP 兜底做成 `KEY_IP_RPM`（默认 0 = 关闭），文档说明何时开启。
3. **文档**：`.env.example` 里 `STATUS_PUBLIC=false` 的注释已提醒暴露风险，补一句"暴露前先设 KEY_DEFAULT_RPM"。

---

## 可直接执行的修复提示词

```
为 RelayGate 的转发面补上默认限流。

现状（已核实）：
- src/middleware/rate-limit.js:14 的 fallback 是 0 = 不限；
- .env.example 未定义 KEY_DEFAULT_RPM；
- 密钥创建 UI（AccessKeysPage.tsx:109 只发 {label}）从不设置 rpm_limit，
  后端 api-keys.js 的 rpmLimit 默认 null —— 所以实际部署中每把密钥都是「不限」；
- index.js:39 允许 10MB 请求体。
组合起来：任何持有一把访问密钥的客户端可以以无限 RPM、每请求 10MB 的强度打转发面，
烧光池内全部账号的真实积分额度，并以同步 SQLite 全表读（store.list 每请求最多 4 次）
拖死事件循环。文件头注释声称对齐 OWASP API4:2023，但默认值恰恰违反它。

请执行：

1) src/middleware/rate-limit.js：
   把 KEY_DEFAULT_RPM 的 fallback 从 0 改为 60，
   并在文件头注释说明为什么默认不再是 0（单机自用 60 RPM = 每秒 1 次，
   对 IDE 场景绰绰有余；批量任务走内部调度不经访问密钥）。

2) .env.example：在转发面/限流章节加入
   # 访问密钥的默认每分钟请求上限（0=不限）。未单独设置 rpm_limit 的密钥适用此值。
   # 若把 HOST 暴露到非 127.0.0.1，务必保持非零。
   KEY_DEFAULT_RPM=60

3) 可选兜底（默认关闭）：新增 KEY_IP_RPM（默认 0=关闭），在 keyRateLimit 之外
   加一个按 req.ip 的粗限流。单人场景所有流量同源 127.0.0.1，
   所以默认必须关闭，仅在 HOST 对外暴露时由用户显式开启；
   在 .env.example 注释里说明这一点。

4) 测试：新增 src/test/rate-limit.test.js
   （或并入 security.test.js）：
   - 构造 rpmLimit=null 的密钥记录，模拟 61 次请求，第 61 次应 429
   - KEY_DEFAULT_RPM=0 显式设置时保持不限（向后兼容）
   - rpmLimit=30 的密钥在 31 次时 429（优先于默认值）

5) 运行 npm test 确认 288 个既有断言 + 新用例全部通过，exit 0。
```