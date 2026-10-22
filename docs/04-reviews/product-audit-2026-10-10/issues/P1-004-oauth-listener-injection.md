# P1-004 — OAuth 本地监听器凭据注入面

| 字段 | 值 |
|---|---|
| **Priority** | P1（默认部署 P2；`HOST≠127.0.0.1` 时 **P0**） |
| **Category** | 安全 |
| **Labels** | `security`, `p1`, `oauth`, `attack-surface` |
| **Difficulty** | 低-中（约 2 小时，含测试） |
| **Risk** | 低（收紧而非放开；需确认不破坏正常 OAuth 流程） |
| **来源** | product-professor full audit 2026-10-10（evidence-verifier 已复核） |

---

## Evidence

### 攻击面 1：GET 分支无 Origin 校验、无 state 强制

本地回调监听器：[src/credentials/oauth.js:161](../../../../src/credentials/oauth.js#L161) 监听 `127.0.0.1:17388`。

```
POST /authorize     → :137-151   有 Origin 白名单校验 ✅
GET  /authorize     → :152-155   无 Origin 校验 ❌  → handleCallbackParams
                                     → completeLogin(creds)
                                        → :245-260  state 不匹配仅 console 警告 ❌
```

**已实读复核** [oauth.js:245-260](../../../../src/credentials/oauth.js#L245-L260)：state 不匹配时只打一条 console 警告（注释原文「仅告警不拒绝」），**随后照常执行 `completeLogin`**。

**对比**：`POST /v1/credentials/oauth/complete`（[credentials.js:337-369](../../../../src/routes/credentials.js#L337-L369)）**是** state 校验的（`oauth.verifyAndConsumeState`，timing-safe + 一次性消费）。

### 攻击路径

```
GET http://127.0.0.1:17388/authorize?refreshToken=X&accessToken=Y&userId=Z
```

任何**本地进程**（无需任何权限）或**恶意网页**（通过 `<img>`/`no-cors` 导航，GET 返回 200 不需要读响应）可发起。成功后：

1. 攻击者控制的"账号"被写入凭据池（`enabled=false`，但可见可启用）
2. 一旦启用，聊天流量被导向攻击者的 Trae 账号 → **上游会话内容外泄**
3. 池调度被污染（错误计数、冷却、余额均被操纵）

### 需确认项（诚实标注）

- **`no-cors` 导航可达性未实测**。浏览器对 `no-cors` 请求仍会发出完整 query string，服务端能收到 —— 理论成立，但未运行验证。
- **本地进程路径无悬念**：`curl "http://127.0.0.1:17388/authorize?..."` 可直接测试。

### 附带发现

[oauth.js:259](../../../../src/credentials/oauth.js#L259) `completeLogin` 中 `creds.state` 不匹配**静默继续**——这同时削弱了 `/oauth/complete` 端点所依赖的 state 纪律。

---

## Why it matters

这是整个系统**唯一的未认证写入面**。其余全部端点都在 `authenticateAdmin` / `authenticate` 后面。修复它之后，系统的安全模型可以简化为"所有写操作都需要密钥"——目前这句宣传语是假的。

在 `HOST=127.0.0.1` 的默认部署下它是 P2（本机恶意软件本就能读 DB）。但：

1. `.env.example` 明确支持改 `HOST`（"跨机访问请显式配置"）
2. 一旦改了，这条立即变成 **远程无认证写入 = P0**
3. 用户没有能力判断自己是否处于危险形态 —— 修复应该在源头

---

## Expected behavior

1. GET 与 POST 两个分支**同等强度**的 Origin/Referer 校验。
2. `completeLogin` 在 `state` 不匹配时**拒绝**（400），而非告警后继续。
3. 不破坏正常 OAuth 流程：Trae 完成授权 → 回调带 state → 匹配 → 完成。
4. 有回归测试覆盖"错误 state / 缺 Origin / 正常流程"三例。

---

## Acceptance criteria

1. `GET /authorize` 携带**错误** state（或无 state）→ 返回 4xx，**不创建账号**，日志记录 `state_mismatch_rejected`。
2. `GET /authorize` 不带 Origin/Referer → 403。
3. `POST /authorize` 正常流程不回归（现有 41 个 security 断言全部通过）。
4. 新增测试进 `src/test/security.test.js`，覆盖上述三例。
5. 移除"仅告警不拒绝"逻辑（grep 该注释确认已删）。

---

## Implementation notes

1. **先确认上游行为**：Trae OAuth 的回调是 GET（redirect URI query）还是 POST。当前代码两者都收，说明作者不确定。若上游固定 GET redirect，则把校验放在 GET 分支即可；若允许，把 `handleCallbackParams` 改为仅 POST 接收是最干净的收法。
2. Origin 白名单复用 [credentials.js:317-325](../../../../src/routes/credentials.js#L317-L325) 的同一份（`localhost|127.0.0.1|*.trae.cn|...`），**抽成共享常量**避免两处漂移。
3. state 校验用现有的 `oauth.verifyAndConsumeState()`（timing-safe、一次性）—— GET 分支直接调用它，**不要自己另写比对**。
4. 日志：拒绝事件走 `writeEvent`（crash.js 的通道）而非 console.log，保证可审计。

---

## 可直接执行的修复提示词

```
收紧 src/credentials/oauth.js 本地回调监听器的凭据注入面。

现状（已核实）：
- 监听 127.0.0.1:17388，POST /authorize 分支（137-151 行）有 Origin 白名单校验，
  但 GET /authorize 分支（152-155 行）完全没有 Origin 校验，直接调 handleCallbackParams
  → completeLogin。
- completeLogin（245-260 行）在 creds.state 不匹配时只打一条 console 警告
  （注释原文「仅告警不拒绝」），随后照常创建账号。
- 任何本地进程或恶意网页（no-cors 导航）都可以 GET 注入任意 refreshToken/accessToken/userId
  进凭据池。
- 对比：POST /v1/credentials/oauth/complete（credentials.js:337-369）是有 state 校验的。

请执行：

1) GET /authorize 分支加上与 POST 分支相同的 Origin/Referer 白名单校验。
   白名单逻辑抽成共享函数（可放 oauth.js 内或 lib/），POST 分支复用同一份，
   避免 :137 与新代码两处漂移。

2) completeLogin 的 state 校验改为强制：
   state 缺失或不匹配 → 返回/记录错误并拒绝创建账号。
   删除「仅告警不拒绝」的注释与行为。
   注意确认调用方（GET 分支与 handleCallbackParams）能处理「校验失败」的返回路径，
   失败时监听器应返回 4xx 而不是 200。

3) 优先方案（如果 Trae 上游回调允许）：把 handleCallbackParams 改为仅接受 POST。
   若上游固定用 GET redirect，则保留 GET 但必须带 1) 与 2) 的全部校验。

4) 拒绝事件用 writeEvent 记录（tag:'security'，event:'oauth_state_rejected'），
   包含来源 IP 与被拒原因，不要只 console.log。

5) 补测试进 src/test/security.test.js：
   - GET /authorize + 错误 state → 4xx，且 accounts 表无新增
   - GET /authorize + 无 Origin/Referer → 403
   - 正常 POST 流程（正确 state + 白名单 Origin）→ 仍能完成登录（防回归）

6) 运行 npm test，确认 41 个既有 security 断言 + 新用例全部通过，exit 0。

注意：不要动 verifyAndConsumeState 的 timing-safe 实现与一次性消费语义。
```