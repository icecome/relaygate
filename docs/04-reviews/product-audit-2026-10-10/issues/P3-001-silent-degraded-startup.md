# P3-001 — 启动链静默降级：DB 损坏 / key 丢失 / 假 health check

| 字段 | 值 |
|---|---|
| **Priority** | P3（升级为 P1 的条件：把 HOST 暴露，或用于无人值守的服务形态） |
| **Category** | 可靠性 / 可运维性 |
| **Labels** | `reliability`, `p3`, `backend`, `startup`, `observability` |
| **Difficulty** | 低-中（约 2 小时） |
| **Risk** | 低 |
| **来源** | product-professor full audit 2026-10-10 |

---

## Evidence

### 1. `/health` 的 `status:'ok'` 是硬编码字符串

[src/index.js:69-79](../../../../src/index.js#L69-L79)：

```js
app.get('/health', (req, res) => {
  res.json({ status: 'ok', accounts: ..., uptime: ..., scheduler: ..., poolStrategy: ... });
});
```

- `status` 不是从任何检查得来的，是字面量
- 但它调了 `status.buildStatus()`（→ `store.list()` → 打 DB），**DB 坏了它会 500**
- 结论：**这是一个 uptime 探针，不是 health check**。Windows 服务管理器 / srvany 无法据此决定是否重启

### 2. DB 损坏 → 静默半死

[src/index.js:169-183](../../../../src/index.js#L169-L183) 的 try/catch **只包住 bootstrap**，`ensureSchema` 不在其中。

失败模式：

```
进程启动成功 ✅
端口监听成功 ✅
调度器全部启动 ✅（scheduler / balance-refresh / backup / zcode-rewards）
每个需要 DB 的请求 → 500 ❌
/health → 500 ❌（且这是唯一能发现问题的信号，但它返回 500 而非结构化的 unhealthy）
```

用户看到的是"面板打不开"，不知道是 DB 坏了。

### 3. `encrypt.key` 丢失 = 不可逆数据丢失，无启动期校验

[src/lib/crypto.js:51](../../../../src/lib/crypto.js#L51) —— key 缺失时**生成新 key 并落盘**。

若 DB 里有密文行而 key 是新建的：
- 所有账号 token 永远解不开
- 无任何提示 —— 用户只会看到账号"登录失效"
- **不可恢复**（旧 key 已丢）

**应有的检查**：启动时若 `accounts` 表存在非空 `token_enc` 且 `encrypt.key` 是本次新建的 → **拒绝启动并明确报错**。

### 4. 配置文件损坏 → 静默兜底

| 文件损坏 | 行为 | 用户可见后果 |
|---|---|---|
| `model-config.json` | 静默 `{models:{}}` | 所有物理模型走兜底分支；`openai.js:97` 的 `inLocalTraeModels()` 误判 |
| `model-router.json` | 静默 `virtualModels:{}` | 所有 `vm/*` 被当物理模型发给上游 → 400，**但面板仍显示"路由正常"** |

### 5. 启动顺序反了

[src/index.js:143](../../../../src/index.js#L143) `scheduler.start()` 在 [:152](../../../../src/index.js#L152) `retention.pruneAtStartup()` **之前**执行。日志清理应在调度器启动前完成（否则首个定时任务可能在清理过程中触发），且 `pruneAtStartup` 是同步阻塞的。

### 6. ✅ 唯一正确的崩溃点

[src/config.js:86-88](../../../../src/config.js#L86-L88) —— `API_KEY === ADMIN_KEY` 时 throw，被 [crash.js:56-65](../../../../src/log/crash.js#L56-L65) 记录后 exit 1。**这是项目里唯一一个"宁可崩溃也不静默降级"的设计**，值得作为其他场景的模板。

---

## Why it matters

**静默降级比崩溃更难排查。** 崩溃会留下日志和退出码；静默降级留下的是"面板打不开"和"模型不能用"，用户需要自己去猜是哪一层坏了。

对一个自托管工具，主人不在现场时（服务形态），静默降级意味着**问题被发现的时间从"启动时"推迟到"下次使用时"**。

---

## Expected behavior

1. `/health` 返回**真实的**健康状态：`{ status: 'ok'|'degraded'|'unhealthy', checks: { db, modelConfig, modelRouter, encryptKey } }`，任何检查失败时返回 503。
2. 关键资源损坏时**明确报错**，而不是静默兜底：
   - DB 无法打开 → 退出码 1 + 明确日志
   - `encrypt.key` 新建但 DB 有密文 → 退出码 1 + 明确日志
   - `model-config.json` / `model-router.json` 解析失败 → 打 WARN 并在 `/health` 里体现 degraded
3. 启动顺序修正：日志清理在调度器启动之前。

---

## Acceptance criteria

1. `/health` 在 DB 不可用时返回 **503** 且 body 含 `checks.db = 'fail'`。
2. 手动破坏 `encrypt.key`（改名）后重启：进程**拒绝启动**并打印明确原因（当前会静默生成新 key）。
3. 破坏 `model-router.json`（写入非法 JSON）后重启：`/health` 返回 degraded，且 `/ops/config` 面板能看到该状态。
4. `retention.pruneAtStartup()` 在 `scheduler.start()` 之前调用。
5. 新增测试覆盖：DB 打开失败、key 不匹配、配置文件损坏三种场景的启动行为。

---

## Implementation notes

### `/health` 的正确形状

```js
app.get('/health', (req, res) => {
  const checks = {
    db: safeCheck(() => { db().prepare('SELECT 1').get(); return true; }),
    modelConfig: config.modelConfig?.models && Object.keys(config.modelConfig.models).length > 0,
    modelRouter: ..., // 有虚拟模型或明确为空（区分"未配置"与"读失败"）
    encryptKey: ...,  // key 是否与 DB 兼容（见下）
  };
  const ok = Object.values(checks).every(Boolean);
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unhealthy', checks, uptime: ... });
});
```

**注意**：`/health` 是免鉴权的。新的 checks 不应泄露敏感信息（只返回布尔/枚举，不返回路径或内容）。

### `encrypt.key` 兼容性检查

```js
// 启动时
const keyWasCreated = /* crypto.js 需要暴露这个信息 */;
if (keyWasCreated) {
  const hasCiphertext = db().prepare(
    'SELECT COUNT(*) c FROM accounts WHERE token_enc IS NOT NULL AND token_enc != ""'
  ).get().c > 0;
  if (hasCiphertext) {
    // 明确报错并退出
  }
}
```

需要在 `crypto.js` 的 `getEncryptionKey()` 里返回/记录"本次是否新建"。

---

## 可直接执行的修复提示词

```
修复 RelayGate 启动链的静默降级问题。

已核实的事实：
1) src/index.js:69-79 的 /health 里 status:'ok' 是硬编码字面量，
   但它调 status.buildStatus() → store.list() → 打 DB，DB 坏了会 500。
   → 这是 uptime 探针不是 health check，服务管理器无法据此重启。
2) src/index.js:169-183 的 try/catch 只包住 bootstrap，ensureSchema 不在其中。
   DB 损坏时进程启动成功、端口监听成功、所有调度器启动，但每个需要 DB 的请求 500。
3) src/lib/crypto.js:51 —— encrypt.key 缺失时静默生成新 key 并落盘。
   若 DB 里已有密文行，所有账号 token 永远解不开，且无任何提示，不可恢复。
4) model-config.json / model-router.json 损坏时静默兜底为空对象，
   前者让所有模型走兜底分支，后者让所有 vm/* 被当物理模型发给上游报 400，
   而面板仍显示「路由正常」。
5) src/index.js:143 scheduler.start() 在 :152 retention.pruneAtStartup() 之前执行，顺序反了。
6) 正面参考：src/config.js:86-88 的 API_KEY===ADMIN_KEY 检查是项目里唯一
   「宁可崩溃也不静默降级」的设计，其他场景应照此办理。

请执行：

【1. 重写 /health】
src/index.js 的 /health 改为返回真实检查结果：
  checks = {
    db:          能否执行 SELECT 1
    modelConfig: 是否解析成功且非空（区分「未配置」与「读失败」）
    modelRouter: 同上
    encryptKey:  是否与 DB 兼容（见第 3 项）
  }
  全部通过 → 200 { status:'ok', checks }
  任一失败 → 503 { status:'unhealthy', checks }
注意 /health 免鉴权：checks 只返回布尔/枚举，不要返回路径或内容。
同时保留现有字段（accounts/uptime/scheduler/poolStrategy）供面板使用。

【2. DB 失败要明确】
把 index.js 启动流程里的 ensureSchema 纳入 try/catch；
DB 无法打开或 schema 初始化失败时，打印明确错误并 process.exit(1)，
不要让它进入「启动成功但每请求 500」的状态。

【3. encrypt.key 兼容性校验（防不可逆数据丢失）】
- src/lib/crypto.js 的 getEncryptionKey() 需要暴露「本次是否新建了 key」这个信息
  （例如设置一个模块级标志或返回 {key, created}）。
- src/index.js 启动时：若 key 是本次新建的，且 accounts 表存在非空 token_enc 行，
  则打印明确错误（「检测到已有加密凭据，但 encrypt.key 缺失并已重新生成。
  继续启动会导致所有账号 token 无法解密。请从备份恢复 encrypt.key，或确认要放弃既有凭据。」）
  并 process.exit(1)。

【4. 配置文件损坏要可见】
model-config.json / model-router.json 解析失败时：
- 打 WARN 日志（含文件路径与解析错误）
- 在 /health 的 checks 里体现为 fail
- 在 /v1/admin/config 的返回里加一个 warnings 数组，让 OpsPage 的配置面板能展示

【5. 修正启动顺序】
index.js 中把 retention.pruneAtStartup() 移到 scheduler.start() 之前。

【6. 测试】
新增 src/test/startup.test.js：
- DB 打开失败 → 进程退出码 1（可用子进程方式测）
- key 新建 + DB 有密文 → 退出码 1
- model-router.json 非法 JSON → /health 返回 503 且 checks.modelRouter 为 fail
- 正常启动 → /health 返回 200

运行 npm test 确认 288 个既有断言 + 新用例全部通过，exit 0。
```