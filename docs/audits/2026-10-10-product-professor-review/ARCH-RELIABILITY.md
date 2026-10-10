# RelayGate — 架构与可靠性审查

审查对象：`C:\opt\workstations\project\web\RelayGate`（backend `src/` 108 文件 / 前端 `web/src/` 46 文件）
方式：直读代码 + 实跑测试与构建。所有结论标注 **CONFIRMED**（已读代码/已执行验证）或 **NEEDS-CONFIRMATION**（需运行期压测或未跑通路径）。

**实跑结果**（本次审查实际执行）：

| 命令 | 结果 |
|---|---|
| `node src/test/unit.test.js` | 236 passed / 0 FAIL, exit 0 |
| `node src/test/growth.test.js` | 11 passed, exit 0 |
| `node src/test/security.test.js` | 41 passed, exit 0 |
| `cd web && npm run build` | ✅ `tsc -b && vite build` 成功，entry `index-Bcoc3emJ.js` 195.84 kB (gzip 64.46)，CSS 21.86 kB (gzip 5.47)，共 15 chunk，构建 1.11s |
| `cd web && npm run lint` | ✅ `eslint .` 无输出，exit 0 |

总计 **288 个断言全绿**。这个数字对下文的结论很重要——它同时说明了测试**测到了什么**和**没测到什么**（见 §6）。

---

## 影响排序（先看这个）

| # | 级别 | 一句话 |
|---|---|---|
| 1 | **P0** | `pool.js` 的 `pick()` → `store.update()` 全表读-改-写，在"单写者"假设下工作；任何并发管理面写（面板改优先级/启用/标签）会**静默回滚该账号的 `last_picked_at`/冷却/errorCount**，且 pick 无互斥导致并发重复选同一账号 |
| 2 | **P0** | 无优雅停机：`log/crash.js:78-83` 的 SIGINT/SIGTERM 处理器 **`process.exit(0)` 前不 flush 任何在途状态**，`stats-cache`、`sticky`、pool 冷却全丢；`index.js` 没有任何 shutdown 钩子 |
| 3 | **P1** | 三条转发路由（openai/anthropic/responses）**各自手写一遍** "鉴权→ACL→pool.run→consumeStream→createStreamHandler→错误帧→日志"，没有 protocol-adapter 层；`transform/` 只覆盖了最内层的事件归一化 |
| 4 | **P1** | 流开始后（`res.headersSent`）**没有任何重试**：openai 的 `pool.run` 轮换轮次会被重置但已发出的半截字节不可撤回，客户端拿到"半截内容 + content 里嵌 `[Error …]`"的**假 200** |
| 5 | **P1** | 配置面 **7 层并存**且互不校验：`.env` / `model-config.json` / `model-fallback.json` / `model-router.json` / 5 个 `.trae-api/*-settings.json` / DB。其中 `model-fallback.json` **完全没有消费者**，`.env.example` 里 3 组 flag 是幽灵配置 |
| 6 | **P2** | 轮换系统（4 文件 ~750 行）是**真实实现的真功能**，但其成功前提（Session 0 → 用户会话 schtasks /IT 拉起 GUI）在当前服务形态下**大概率失败**，代码注释自己承认了这点；复杂度换来的成功率未经运行期验证 |
| 7 | **P2** | 前端分层是真的，`shared/ui/index.tsx` 422 行中**只有 27 行是死代码**（`EmptyState`）；8 条 lazy 路由全部可达 |
| 8 | **P3** | 启动链路的失败模式整体是"降级"而非"崩溃"，但降级是**静默**的：DB 损坏 / `model-config.json` 损坏会被 `catch` 吞掉并以空配置继续服务 |

---

## 1. LAYERING — 分层没有被强制，协议逻辑三份手写

### 声称的层次 vs 实际

`src/index.js:4` 声明：`routes(薄) → transform(纯函数) → upstream(唯一上游通道) → auth(复用)`。
实际依赖图（由 `src/routes/*.js` 的 import 全量提取，**CONFIRMED**）：

```
routes/openai.js ──┬─→ upstream/client.js   (llmUtilsChat, consumeStream)
                   ├─→ credentials/pool.js  (pick/run/record)   ← 直达状态层
                   ├─→ session/sticky.js                          ← 直达状态层
                   ├─→ models/availability.js  (markUsable/markUnavailable)
                   ├─→ models/rates.js         (estimateCost)
                   ├─→ log/traffic.js          (直接写日志)
                   ├─→ model-router/index.js   (第二个完整调度器)
                   ├─→ middleware/model-access.js
                   └─→ workbuddy/chat.js       (第三个上游通道！)
```

**结论：分层是注释里的，不是代码里的。** `transform/` 只承担了"上游 SSE 事件 → 归一化 event 对象"这一段（`transform/sse.js` 361 行 + `emitters.js` 91 行 + `request.js` 59 行 + `continue.js` 93 行），**请求侧/响应侧的协议映射完全没有被抽象**。

### 三个路由的手写重复（CONFIRMED，逐项对照）

| 职责 | openai.js | anthropic.js | responses.js | dispatch.js |
|---|---|---|---|---|
| 平台/ACL 前置检查 | `openai.js:218-238` | `anthropic.js:75-95` | `responses.js:61-82` | — |
| `pool.run` 包裹 | `openai.js:450,542` | `anthropic.js:143` | `responses.js:122,181` | `dispatch.js:236,263,369,454` |
| SSE 头设置 | `openai.js:369-372` | `anthropic.js:113-116` | `responses.js:110-113` | `dispatch.js:96-101,358-363,463-468` |
| `createStreamHandler` + `createLineFeeder` + `consumeStream` + `flushToolAccum` | `openai.js:398-437` | `anthropic.js:125-149` | `responses.js:128-148` | `dispatch.js:372-413` |
| 流内 error → 异常 → 回灌账号池 | `openai.js:415-423` | `anthropic.js:132-136` | `responses.js:136-142` | `dispatch.js:394-400` |
| "已发头" 错误帧补写 | `openai.js:510-514` | `anthropic.js:169-174` | `responses.js:161-175` | `model-router/index.js:359-366` |
| `logRequest` 收尾 | `openai.js:516-531` | `anthropic.js:176-193` | `responses.js:154-174` | `model-router/index.js:310-348` |
| finish_reason 改写（tool_calls / 截断优先） | `openai.js:140-145` | `anthropic.js:153-156` | ❌ 无 | `dispatch.js:162-166` |

**同一套 8 步骨架被复制了 4 遍**（三个 route + `model-router/dispatch.js`），差异只在字节渲染格式。这是本项目最大的维护面成本来源。

### 具体的分叉证据

- **`transform/` 有 `createLineFeeder` 却没人用它做协议适配**：`lib/sse-lines.js` 被 4 处各自 require（`openai.js:26`, `anthropic.js:17`, `responses.js:20`, `dispatch.js:11`），每处都要自己写 `const feeder = createLineFeeder((line) => handler.feedLine(line))`。
- **`dispatchTraeStream` 与 `openai.js` 的流路径是两份等价实现**：`dispatch.js:330-331` 的注释直接承认"事件边界与 `routes/openai.js` 同一套解析层，差异仅在出口"。两份实现在 `markIncomplete` 上传了**不同的常量**：`openai.js:431` 用 `config.markIncompleteToolArgs`，`dispatch.js:407` 硬编码 `false`。同一入参在两条路径下产生不同的 finish_reason 行为（**CONFIRMED**）。
- **`transform/finish.js` 只有 17 行**（`isTruncatedFinish`），却被 4 个模块 require。这是唯一被真正共享的协议语义，恰恰说明其余协议语义都没被共享。
- **`responses.js` 缺 finish_reason 语义**：`responses.js:149-152` 无条件写 `status: 'completed'`，不区分截断。同一个上游截断在 `/v1/chat/completions` 上是 `finish_reason:'length'`，在 `/v1/responses` 上是"成功"（**CONFIRMED**）。
- **`responses.js:86-94` 因工具事件族未实现而 fail-closed 拒绝带 tools 的请求**，`admin-overview.js:113` 的面板文案却只写"复杂事件族可能不完整"——**文档与实际能力不一致**（CONFIRMED）。

### 路由直达状态层（绕过 pool）

`middleware/model-access.js:9-10` 注释称"`store` 是无依赖的叶子模块"，但 `model-access.js:71-81` 对虚拟模型**直接放行**、`model-access.js:96-98` 对 workbuddy 平台密钥只查 `resources` 数组。`openai.js:169` 用 `modelRouter.hasVirtualModel(model)` 分流——**这等于在路由层实现了一次二级路由**，而不是把 virtual/物理模型的差异藏在 `upstream` 层。

---

## 2. STATE MANAGEMENT — 内存态的清单与重启损失

### 后端全部可变内存态（CONFIRMED，逐处定位）

| 位置 | 内容 | 重启后 | 是否有 flush |
|---|---|---|---|
| `credentials/pool.js:41` `inFlight` | 进程内在途计数 | 丢失 | ❌ |
| `credentials/pool.js:44` `recentStart` | 每账号滚动窗口起点 | 丢失 → 重启瞬间可对同账号连打 | ❌ |
| `credentials/pool.js:51` `waiters` + `_wakeTimer:191` | FIFO 等待队列 | **队列里的请求全部悬挂至 30s 超时** | ❌ |
| `session/sticky.js:9` `map` | 会话→账号绑定（TTL 1h） | 丢失（文件注释 `sticky.js:4` 自称"可接受"） | ❌ |
| `log/stats-cache.js:76` 磁盘桶 + `traffic.js:91` invalidate | 统计聚合桶 | **不丢**，但每次 `logRequest` 都 `fs.existsSync + fs.unlinkSync`（见下） | ✅（磁盘） |
| `model-router/health.js:12` `stats` | 候选健康度/冷却/成功率 | 丢失 → 冷却清零，重启即打限流中的候选 | ❌ |
| `model-router/health.js:15` `rpmWindow` | 候选 maxRpm 滑窗 | 丢失 | ❌ |
| `middleware/rate-limit.js:8` `windows` | 密钥级 RPM 滑窗 | 丢失 → **重启即重置限流配额** | ❌ |
| `log/traffic.js:16` `seq` | 日志序号 | 重置 → 同日 `seq` 重复 | ❌ |
| `upstream/client.js:19` `sseDebugSeq` | 调试序号 | 同上 | ❌ |
| `zcode/captcha.js`, `jobs/rotate-accounts.js:167` `ownSessionIdCache`, `rotate-accounts.js:362` `rotateRunning` | 各类缓存/互斥 | `rotateRunning` 丢失 → 重启后另一进程可并发轮换 | ❌ |

### 优雅停机：**不存在**（CONFIRMED）

```
src/index.js          — 全文无 SIGINT/SIGTERM/process.on('exit')/server.close()
src/log/crash.js:78-83 — 唯一的信号处理器：
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => {
        writeEvent({ tag: 'lifecycle', event: 'signal', signal: sig });
        process.exit(0);        // ← 直接退出
      });
    }
```

- 没有 `server.close()`：在途 HTTP/SSE 连接被硬切断。
- 没有 `db().close()`：`credentials/db.js` 的 `DatabaseSync` 从不显式关闭（`_db` 无 close 导出）。
- 没有 flush `stats-cache` / `sticky` / pool 状态。
- **`crash.js:78` 的信号处理器与 `index.js` 无任何协调**：即便将来加 flush 也不会被调用，因为 `process.exit(0)` 在同一个 tick 内立即终止。
- **反证**：`jobs/scheduler.js:39` 的 `scheduleEpoch` 机制（注释 `scheduler.js:32-38`）说明作者已经处理过"重启/重排导致任务重复触发"，但那是在**进程内** `restart()` 语义下；**跨进程重启的定时任务重复触发没有任何保护**（无 pidfile、无文件锁、无"上次运行时刻"的持久化判断）。`scheduler.js:40-52` 的 `state` 对象全是内存字段。

### 一个具体的进程内竞态（CONFIRMED）

`jobs/scheduler.js:317` `rotateTimer` + `rotate-accounts.js:362` `rotateRunning` 是**同一进程内**的互斥。但 `start.bat` 的孤儿清理只在"端口被 node.exe 占用"时才 kill：
```
start.bat: 'for /f "tokens=5" %%P in (netstat ... :%PORT% ... LISTENING)'
```
若旧进程已 `process.exit` 但 srvany 尚未回收、或端口因时序尚未 LISTEN，**两个 scheduler 可以并存**——`start.bat:44-46` 的注释自己也写了 "two schedulers would run side by side"。此时两个进程各自持有全套内存态（pool/sticky/health/rate-limit），并**共用同一个 SQLite 文件**，直接触发 §3 的写冲突。

### stats-cache 的每请求 syscall（CONFIRMED，性能）

`log/traffic.js:88` 写完 jsonl 后，`traffic.js:91` 调 `invalidateDay()`；`stats-cache.js:250-255`：
```js
const file = cacheFile(dateKey || todayKey());
if (fs.existsSync(file)) fs.unlinkSync(file);
```
`cacheFile()` → `CACHE_DIR()`（`stats-cache.js:25-30`）每次做 **两次 `fs.existsSync`**（新目录 + 旧目录回退），再加一次 `existsSync`（缓存文件）。即**每个转发请求固定 3 次同步 stat + 最多 1 次 unlink**，且全部在 `logRequest` 的同步路径上（`traffic.js:88` 是 `appendFileSync`）。这与 `traffic.js:17-18` / `traffic.js:85` 注释里"避免每请求一次 mkdir syscall"的优化意图**自相矛盾**——mkdir 被省掉了，stat 又加回来了。

---

## 3. CONCURRENCY — 单 SQLite 连接，无互斥，写路径是读-改-写

### 连接模型（CONFIRMED）

`credentials/db.js:194-203`：模块级单例 `_db = new DatabaseSync(DB_FILE())`，`node:sqlite` 的 **同步 API**（`prepare().run()` 阻塞调用线程）。`db.js:198-200` 只设了 `PRAGMA busy_timeout = 5000`。

**关键结论：`busy_timeout` 在这里几乎没有作用。** `busy_timeout` 解决的是"另一个进程/连接持锁"，而本项目是单连接单进程——同进程内的 `DatabaseSync` 调用天然串行（JS 单线程 + 同步 C++ 调用），不存在锁竞争。真正的问题是**这个串行是同步阻塞的**（见下）。

### 写序列化：靠"单写者"的隐含假设，不是靠锁（CONFIRMED）

`credentials/store.js:207-231`：
```js
function update(id, patch) {
  const existing = get(id);                 // ← 全表 SELECT * + 解密
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  const r = acctToRow(merged);
  db().prepare('UPDATE accounts SET ... (34 列全部重写) ... WHERE id = ?').run(...);
  return safeTok(merged);
}
```

**没有 `WHERE` 条件保护、没有版本号、没有事务、没有 mutex。** 在 `node:sqlite` 同步语义下，`get()` 与 `run()` 之间不会被其他 JS 代码插入（除非其间有 `await`；这里没有），所以**单次 `update` 本身是原子的**。

**但下列复合操作的 read-modify-write 跨了函数边界，不原子：**

1. **`pool.pick()` 的 TOCTOU（CONFIRMED）**
   `pool.js:422` `const all = store.list().filter(...)` → `pool.js:487` `store.update(chosen.id, { lastPickedAt: now })` → `pool.js:488` `markStart(chosen.id)`。
   `store.list()`（`store.js:101-104`）是 `SELECT * FROM accounts` **全表 + 全字段**，完成后所有行 `safeTok` 剥密文。**两个并发请求（同一 tick 内因 `await` 让出，例如 `ensureAuth` 里的 `await legacy.exchangeToken`）会读到同一份快照，选出同一个 `chosen`。** `pick` 没有 `inFlight` 的原子预留——`acquire()` 在 `pool.js:671` 才调用，且 `hasCapacity()` 检查发生在 `pick` 内部的 `pool.js:429`。窗口 = `list()` 的同步时长 + 到 `acquire()` 之间的任意 `await`。

2. **面板写会静默回滚调度状态（CONFIRMED，P0）**
   设：`pick()` 在 t0 读完快照 S（`lastPaidAt=0`）。在 t1（同一请求内后续 `await` 期间）管理员通过 `routes/credentials.js` 调 `store.update(id, { priority: 5 })`。`store.update` 内部 `get(id)` 重新读**最新**行，合并 priority 后**全列重写**——把 `last_picked_at` 写成 t1 时的值（或旧值）。随后 t2 `pick` 的 `store.update(id, {lastPickedAt: now})` 用**陈旧快照 S** 重建整行，**把管理员的 priority=5 覆盖回旧值**。反之亦然。
   `store.update` 的 34 列全量重写（`store.js:212-229`）让**任何一个字段的陈旧都会污染其余 33 个字段**。这是本项目最危险的数据一致性缺口。

3. **`pool.record()` 的 `coolModel` + `store.update` 两步非原子（CONFIRMED）**
   `pool.js:571-582`：`coolModel(a, model, ...)`（`pool.js:328-337` 内部自己 `store.update`）然后又一次 `store.update(id, { rateStreak })`。两次写之间读到的 `a` 都是旧快照。

4. **`explainCandidates` / `snapshot` 在只读接口里写库（CONFIRMED）**
   `pool.js:724-725` 和 `pool.js:749-750`：`if (pruned) store.update(a.id, { modelCooldowns: pruned })`。`GET /v1/admin/route-check`（`admin-overview.js:18-33`）和 `GET /v1/admin/runtime`（`admin-overview.js:125`）会**在 map 循环中对每个账号做一次全列 UPDATE**。`status.js:28` 的 `pool.snapshot()` 同样如此，而 `/status` 在 `STATUS_PUBLIC=true` 时**免鉴权**（`status.js:41` + `middleware/auth.js:86-89`）。→ **未鉴权端点可以触发 N 次账号全表写**。

5. **备份/恢复与进程内调度直接对撞（CONFIRMED）**
   `jobs/backup.js:426-436` 的 `runInTransaction` 手写 `BEGIN`/`COMMIT`，`backup.js:439-451` 的 `upsertById` 是逐行 `INSERT ... ON CONFLICT DO UPDATE`。这段时间内，任何 `pool.pick()` → `store.update(chosen.id)` 都在同一连接上执行——**它不参与该事务**（`node:sqlite` 的 `DatabaseSync` 对同一连接、同一线程，BEGIN 之后的所有语句都在事务内）。即 **`pick` 的 `last_picked_at` 写会被并入恢复事务**，恢复回滚时一并丢失；恢复提交时会覆盖未参与备份的实时状态。`db.js:102-124` 的 `api_keys` 重建迁移是同样的 `BEGIN`/`COMMIT` 模式，**发生在启动期**，此时 scheduler 尚未 start（`index.js:143` 在 listen 回调里），风险较低。

### 同步阻塞导致的事件循环停顿（CONFIRMED，量级 NEEDS-CONFIRMATION）

`store.list()` 全表 `SELECT *` + 每行 6 个 JSON.parse（`store.js:121,123,135,137,143,145`），注释 `store.js:98` 自称"1000 账号约 27ms/次"。

`pick()` 一次调用内 `store.list()` 的次数：
- `pool.js:422` 主过滤 1 次
- `pool.js:140` `pickCandidate`（若走 `couldPick` → `wakeWaiters`）
- `pool.js:161` `nextAvailableIn` 1 次
- `pool.js:495` `alertIfPoolEmpty` 1 次（池空时）
- `pool.js:63-66` `maxWaiters()` 有 5s 缓存，OK

在**每次上游请求**的路径上（`pool.run` → `pick` → `store.list()` 27ms），事件循环被同步阻塞 27ms+。期间所有并发 SSE 写入、`fetch` 回调、定时器都被冻结。**1000 账号规模下，数并发请求就能造成秒级全球停顿。** 这是单连接 `node:sqlite` 架构的固有代价，代码里没有任何缓解（无 account cache、无 prepared statement 复用、无分页）。

---

## 4. ERROR RECOVERY — 流中途失败：客户端拿到"假 200 + 半截内容"

### 上游流内 error 的处理链（CONFIRMED）

`transform/sse.js:258-268` 把上游 `event:error` 归一为 `{type:'error', code, message}`。
`openai.js:415-423`：
```js
case 'error': {
  requestError = evt.message;
  if (isRateLimitCode(evt.code)) pool.record(accountId, 'rate_limit', {...});
  const e = new Error(...); e.code='UPSTREAM_STREAM_ERROR';
  if (evt.code != null) e.upstreamCode = evt.code;
  throw e;                    // ← 在 emit 回调里 throw
}
```
这个 throw 从 `createStreamHandler` 的 emit 回调里抛出，穿过 `feeder.feedLine` → `feeder.feed`（`lib/sse-lines.js`）→ `consumeStream` 的 `onText(chunk)` 回调 → `upstream/client.js:415` 的同步调用点 → 冒泡出 `consumeStream` 的 await → 被 `openai.js:504` 的 `catch (err)` 接住。

**问题：上游的 `reader.read()` 循环已被 throw 中断，`up.body` 的 Web ReadableStream 从未被 cancel**（`upstream/client.js:405-427` 的 `consumeStream` 没有 `finally { reader.cancel() }`）。上游 HTTP 响应体泄漏。**CONFIRMED**——`consumeStream` 的 Web 分支（`client.js:407-418`）和 Node 分支（`client.js:420-426`）都没有清理逻辑。

### 中途失败的下场（CONFIRMED）

`openai.js:510-514`：
```js
if (!res.writableEnded) {
  write(out.error(completionId, model, err.upstreamCode ?? (err.status===429?429:null), err.message));
  res.end();
}
```
`transform/emitters.js:48-50`：
```js
error(id, model, code, message) {
  return [sse(openaiChunk(id, model, { content: `\n[Error ${code||''}: ${message||'unknown'}]` }, null))];
}
```
→ 客户端收到的是一个 **HTTP 200 `text/event-stream`**，其中 delta.content 里插了一段人类可读的错误文案，**没有 `finish_reason`，没有 `[DONE]`，没有标准 `error` 对象**。

**这是本审查里最严重的客户端契约破坏：**
- 支持 `tool_calls` 的 agent 客户端会把 `[Error 3004: ...]` 当成模型的正常输出继续处理。
- 没有 `[DONE]` → 严格遵守 SSE 的客户端会**挂起直到超时**。
- `finish_reason` 从未下发（`openai.js:494` 的 `finished` 仍为 false，但 `res.end()` 已发生）。

对比 `/v1/messages`（`anthropic.js:172`）用的是**正确的** `{type:'error', error:{type,message}}`，`/v1/responses`（`responses.js:165`）用的是 `response.failed` 事件——**三个协议出口对同一个失败的表达质量完全不同**（CONFIRMED）。

### 流开始后没有重试（CONFIRMED）

`pool.run` 的轮换判定（`pool.js:677-685`）只看 `classifyError(err)` 是否 `auth|quota|rate_limit`。但**更大更早的失效模式是 `dispatchTraeStream` 路径下的 `e.code='UPSTREAM_STREAM_ERROR'`**（`dispatch.js:396-399`）——`classifyError`（`errors.js:34-57`）对它的判定依赖 `err.upstreamCode`：若有 `upstreamCode` 且命中 `RATE_LIMIT_CODES` → `rate_limit`（会重试）；**否则落 `other`（`errors.js:56`），不重试，直接抛给客户端**。

`model-router/index.js:349-350` 有显式守卫：
```js
const canSwitch = shouldSwitch(kind, vm) && i < maxAttempts - 1
  && !(ctx.stream !== false && res.headersSent);
```
注释与 `admin-overview.js:119` 的面板文案都承认："**流式一旦开始输出，不在中途切换账号重试。**"

**这是刻意的设计取舍，但代价没有被传递出去**：客户端无法区分"上游在 200 后崩了"与"模型只说了半句话"。

### `openai.js` 重置流的 bug（CONFIRMED）

`openai.js:450-456`：
```js
await pool.run(async (accountId) => {
  finished = false; toolCallIndex = 0; toolCalls = 0; started = false; requestError = null;
```
`started = false` 后，若这是 `pool.run` 的第 2 次尝试（第一次在流中途失败），`ensureStart()`（`openai.js:380-385`）会**再次下发 `out.start(...)` role 帧**。但已发出的字节无法撤回 → 客户端收到**两个 role 帧、两份内容**。

实际上这条路径被 `pool.run` 的 `finally { release(accountId) }`（`pool.js:686-688`）与 catch 的 `throw err`（`pool.js:682`）挡住——`other` 类错误不重试，直接 `throw`。**所以这个 bug 目前在 `kind='other'` 下不可达，但 `kind='rate_limit'` 时可达**：`pool.js:682` 允许 `rate_limit` 重试，而 `openai.js:418` 对 `isRateLimitCode(evt.code)` 的流内错误正是先 `pool.record(..., 'rate_limit')` 再 throw。→ **若上游在流中途发 3004，客户端会拿到重复的 role 帧与拼接的两段内容。** 严重度取决于上游是否真会在流中途发 3004（**NEEDS-CONFIRMATION**，需抓包验证）。

### `dispatch.js` 流路径的 usage 丢失（CONFIRMED）

`dispatch.js:501-504`（WorkBuddy 直通）：
```js
if (ev.usage) { usage = peekUsageDetail(ev.usage); delete ev.usage; }
```
删掉 usage 后，**只有 `usage` 非空时**才在 `dispatch.js:522` 补发末帧。若上游从不带 usage，客户端拿到的流**没有 usage 字段也没有 finish_reason 补充帧**——`finish_reason` 由上游末帧自己带（`dispatch.js:513-517` 只改写、不新增）。

### `transform/continue.js` 的成本放大（CONFIRMED）

`continue.js:59-75`：最多 `maxContinues`（默认 5，`config.js:122`）轮续写，每轮把**全部已产出内容 + 原始 messages**重新发一遍（`continue.js:74` `rounds.push(buildContinueMessages(messages, content))`）。
- **每轮都重新跑一遍 `pool.run` 的完整选号**（`openai.js:473-477` 的 `callOnce` 内部又调 `runRound` → 但注意 `runRound` 在 `pool.run` 的**同一次租约内**，见 `openai.js:450` → 所以续写轮次**共用同一账号租约**，不重新选号）。✅ 这一点是对的。
- **但 `messages` 每轮全量重发**：第 5 轮的 prompt ≈ 原始输入 + 5×已产出内容。对长输出场景，token 成本最高放大到 ~6×，且**计费日志只记最后一轮的 usage**（`openai.js:426` `lastUsage = evt.data`，每轮覆盖）。→ **成本被系统性低估**（CONFIRMED）。
- `continue.js` 在有 `toolCalls` 时 break（`continue.js:69`），这个边界处理是对的。

---

## 5. THE ROTATE SYSTEM — 真功能，但前提在当前部署形态下不成立

### 它在做什么（CONFIRMED）

`jobs/rotate-accounts.js:5-6` 的原理注释："替换客户端 auth 文件触发热加载，客户端自动发 API 调用，计入每日活跃分。"

四个文件的职责是清晰且**无循环依赖**的（`unit.test.js` 有专门的不变量测试，见 §6）：
- `rotate-auth-dir.js` (77 行) — auth 目录定位 + 账号发现（`.info` / `.bak-*` / `.seed.*` 三种命名）
- `rotate-seed.js` (106 行) — 从 SQLite 账号库**反向生成** auth 备份文件（`rotate-seed.js:59-79` 按客户端格式拼 `{account, auth}`）
- `rotate-settings.js` (47 行) — 薄配置声明
- `rotate-accounts.js` (563 行) — 主体：停客户端 → 换 auth → 启客户端 → 等 stayMs → 循环

**这不是脚手架，是真实现。** 证据：
- `rotate-accounts.js:29, 50, 59, 179, 207` 是**按实测 Windows 会话模型写就的**：Session 0（服务）看不到 Session 1（用户）的进程 → 改用 `Get-CimInstance Win32_Process`（`rotate-accounts.js:59,179,207`）。
- `rotate-accounts.js:127-164` `trySchtasksStop` 注册临时计划任务以交互用户身份 Stop-Process，并在 `rotate-accounts.js:147-152` 用"12 次 × 3.5s 轮询"代替固定 sleep——注释写明实测迟滞 ~30s。
- `rotate-accounts.js:263` `/IT` 任务从 `/run` 到进程出现实测 ~30s，故 `waitForClientStart(45000, count0)` 用 **count0 基线差值**判定（`rotate-accounts.js:186-200`），避免被 Session 0 的残留隐形进程误判成功。

### 复杂度是否值得（判断）

**部分值得，部分是环境适配的沉没成本。**

**值得的部分：**
- `rotate-accounts.js:346-361` 的失败隔离修复有明确根因（"服务会话下 startClient 必然返回 `reason='service_session'`，于是整遍轮换在第一个账号就断链"）。逐账号 `continue` + 分别记 failed 是正确的。
- `rotate-accounts.js:362-386` 的 `rotateRunning` 互斥（整遍与单账号共用同一把锁），理由（"两者都杀/启客户端进程"）成立。

**不值得/有问题的部分：**
1. **`resolveWbExe()` 每次调用都同步起一个 PowerShell 去查进程路径**（`rotate-accounts.js:28-33`）：
   ```js
   const found = require('child_process').execSync(
     'powershell -NoProfile -Command "Get-Process WorkBuddy ... | Select -ExpandProperty Path"',
     { encoding: 'utf8', timeout: 10000 });
   ```
   `execSync` **阻塞事件循环最多 10s**。它被 `startClient()`（`rotate-accounts.js:253`）调用，而 `startClient` 在轮换循环里对**每个账号**调用一次（`rotate-accounts.js:438`）。这不是热路径（轮换是定时任务），但一个 PowerShell 冷启动就 300-800ms，加上 `probeClientRunning()`（`rotate-accounts.js:50,60`）每次也起 PowerShell——**单次轮换会串行拉起几十个 PowerShell 进程**。
2. **`execSyncQuiet` 用 `execSync` + 字符串命令**（`rotate-accounts.js:76-82`），而同一个文件里 `schtasksCmd` 却刻意用 `execFileSync` + 数组传参（`rotate-accounts.js:229-238`）来"绕开 shell 与 GBK 输出编码层"。**两套子进程调用风格并存**，`resolveWbExe` 里的 PowerShell 命令是字符串拼接（有 `WB_EXE` env 未注入时的注入面，虽然输入是本地配置）。
3. **`spawn` 在 Session 0 的兜底被自己禁掉了**（`rotate-accounts.js:277-285`），这正确，但意味着 **`startClient` 在服务形态下几乎必然返回 `reason:'service_session'`**。此时 `rotate-accounts.js:438-443` 仍会把 auth 文件改掉并记 `failed++` —— **auth 被改写但客户端没起来，活跃度不会记上**。整个功能的产出是"auth 文件在几个账号间来回换"，这在服务形态下**没有可观测的价值**。
4. **`checkStatus()`（`rotate-accounts.js:507-540`）对每个 workbuddy 账号串行 `await fetch` 上游 heatmap**，无并发、无取消。账号多时面板 `/rotate/status` 线性变慢。
5. **`ensureSeedBackups()`（`rotate-accounts.js:309-312`）逻辑等价于无条件 `seedAll()`**：
   ```js
   if (discoverAccounts().length > 0) return { needed: false, ...seedAll() };
   return { needed: true, ...seedAll() };
   ```
   两个分支做同一件事，只有 `needed` 字段不同。这是残留的条件分支（CONFIRMED，可安全合并）。

### 值得肯定的安全处理

`rotate-seed.js:12` 明确"明文 accessToken 仅落本机 auth 目录……绝不写入日志/返回前端"，实际代码也确实只 `writeJsonAtomic` 到 auth 目录（`rotate-seed.js:79`）。`rotate-seed.js:51` 有 `hasBackupFor` 防覆盖客户端最新登录态。这块是克制的。

---

## 6. TEST COVERAGE — 288 断言全绿，但测的是"纯函数与模块契约"，不是"转发正确性"

### 实跑结果

```
node src/test/unit.test.js    → 236 passed, exit 0   (3506 行)
node src/test/growth.test.js  → 11 passed, exit 0    (242 行)
node src/test/security.test.js→ 41 passed, exit 0    (219 行)
```

### `unit.test.js` 的 44 个测试分组（CONFIRMED，逐行提取）

覆盖到的：
- `transform/request`, `transform/sse`（含跨 chunk 工具 JSON 拆分、空参数补偿）, `transform/emitters`
- `upstream/client.buildBody`（含请求体增强、`@max` 档位、`TRAE_BODY_ENRICH=off`）
- `upstream/errors`（分类、`parseRateLimitReset`）
- `credentials/pool`（大量调度语义）, `credentials/credentials`(credits) 纯计算, `credentials/oauth` state
- `log/stats`、`log/client-logs`、`log/retention`、`lib/atomic-write`、`lib/round`、`lib/sse-lines`、`lib/util`
- `jobs/backup` 恢复、`jobs/rotate-accounts` 失败隔离、`jobs/scheduler` 重复排程竞态
- `model-router`（含 `dispatchTraeStream` 真流式：**测了"文本事件逐块写出（首帧先于上游流结束）"和"上游 error 事件抛错"**）
- `platform/variant`、`zcode/*` 全套
- **依赖方向不变量**（静态扫描：无双向 require、`rotate-seed` ⇄ `rotate-accounts` 无循环、`pool` ⇄ `errors` 无循环）

`security.test.js` 41 项覆盖：K-1 管理/转发密钥分离、K-2 scope 403 + 迁移、K-4 reveal 审计、E1 上下文守门 400、E3 含斜杠候选 id 路由。

### **明确没有覆盖的（CONFIRMED，这是重点）**

| 未覆盖项 | 证据 |
|---|---|
| **`routes/openai.js` 的任何行为** | 3 个测试文件均无 `require('../routes/openai')`。`unit.test.js:21` 只 require `upstream/client` 的 `buildBody` |
| **`routes/anthropic.js`** | 无 require |
| **`routes/responses.js`** | 无 require |
| **`routes/*.js` 管理端点（除 security 的 4 个场景）** | 无 HTTP 层测试；无 supertest/express 测试客户端（`package.json` 无 devDependencies） |
| **三个协议的响应字节形态** | 只测了 `exportOpenAI().text()` 与 `exportAnthropic().toolCall()` 的**单块**输出，没测完整流序列（role→content→tool_calls→finish→[DONE]） |
| **§4 的"流中途失败"整条路径** | `dispatchTraeStream` 只测了"上游 error 事件抛错"（未写头场景），**没有测 `res.headersSent` 后的错误帧形态** |
| **`credentials/store.js` 的并发写** | 无并发测试；无 `Promise.all` 场景 |
| **`credentials/db.js` 的 schema 迁移** | `api_keys` 重建迁移（`db.js:99-129`）无测试 |
| **`jobs/backup.js` 的恢复与并发 `pick` 对撞** | 只测了恢复的 happy path |
| **前端全部** | `web/` 无测试框架（`package.json` 无 vitest/jest），无 `.test.tsx` |
| **`middleware/rate-limit.js`** | 无测试 |
| **`model-router/health.js` 的 rpm 滑窗** | 无测试 |
| **`jobs/scheduler.js` 跨进程重复触发** | `unit.test.js:2743` 只测了**进程内** `stop()` 代次机制 |

### 测试质量的隐患（CONFIRMED）

`unit.test.js:31-36`：
```js
async function runAll() {
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`FAIL  ${name}: ${e.message}`); process.exitCode = 1; }
  }
}
```
- `process.exitCode = 1` 是**唯一**的失败信号，且输出里 `FAIL` 前缀在 `console.error`（stderr）而 `ok` 在 stdout。当前 shell 管道（`2>&1 | Select-Object -Last N`）下**若把 stderr 单独重定向，失败会被静默吞掉**。CI 场景下必须严格检查 exit code。
- 全绿时输出 `236 passed`；**有失败时也打印 `N passed`**（`unit.test.js:40`），没有 "N failed"。人类读者只看末行会误判。
- `unit.test.js:12-15` 设置 `WORKSPACE_DIR` 到 `os.tmpdir()`——**这一点必须保持**（`lib/paths.js:4-19` 的注释解释了历史上测试污染过真实 `scheduler-settings.json`）。本次运行未污染真实目录（CONFIRMED：`output/` 未被本审查修改）。

**净判断：测试是"纯函数 + 模块契约"级别的，覆盖广度罕见地好（尤其依赖方向不变量、zcode 运营面、并发竞态的单进程版本），但对**产品核心路径——三个转发协议的字节级正确性、SSE 中途失败、并发写**——零覆盖。288 个绿灯容易被误读为"系统可靠"。

---

## 7. FRONTEND ARCHITECTURE — 分层是真的，死代码很少

### 结构（CONFIRMED）

```
web/src/
  main.tsx                    (15)   ← ReactDOM + BrowserRouter + ErrorBoundary
  app/        App.tsx (136) AppLayout.tsx (106) nav.ts (80)
  features/   accounts/(8) models/(2) ops/(3) overview/(1) setup/(1) stats/(3)
  shared/     api/(11) hooks/(2) lib/(1) ui/(6)
  lib/        store.ts (23)
  styles/     global.css (522)
```

### 分层是否有实质（判断：**是**）

- `shared/api/*` (11 个模块，~1900 行) 是**真正的 API 客户端层**，`http.ts:187-208` 实现了取消（`buildSignal`）、超时（`TimeoutError`）、GET 去重（`inflight` Map）。
- `shared/hooks/useAsyncData.ts` 是**统一的数据获取原语**，被 **10 个 feature 文件、43 处**使用。这不是仪式感——它统一处理了取消/竞态/错误暴露。
- `shared/lib/format.ts` 被 **11 个文件**使用，`formatNumber` 112 次、`formatTime` 36 次。
- `errors` 与业务失败被显式区分：`http.ts:28-31` 的 `isTransport`、`http.ts:214-228` 的 `isBusinessFailure`。这是真实的语义分层。

### 死代码：**只有 1 处（CONFIRMED，逐个 grep 验证）**

对 `shared/ui/index.tsx` 的 16 个 export 逐一 grep 全库（排除自身）：

| export | 行 | 使用数 | 状态 |
|---|---|---|---|
| `Button` | 24 | 60+ | ✅ |
| `Field` | 50 | 4 | ✅ |
| `FieldRow` | 77 | 14 (OpsPage) | ✅ |
| `Stepper` | 108 | 1 (ModelRouterPage:382) | ✅ |
| `Panel` | 183 | 40+ | ✅ |
| `MetricGrid` | 209 | 5 | ✅ |
| `Chip` | 242 | 30+ | ✅ |
| `Segmented` | 266 | 6 | ✅ |
| `KeyValue` | 299 | 1 (ModelPoolPage:270) | ✅ |
| `KeyCards` | 318 | 2 (OpsPage:447,498) | ✅ |
| `KeyCardGroups` | 354 | 2 (OpsPage:1162,1469) | ✅ |
| `Note` | 401 | 10+ | ✅ |
| `ProgressBar` | 418 | 1 (ModelRouterPage:420) | ✅ |
| `LoadingBlock` | 437 | 15+ | ✅ |
| **`EmptyState`** | **445** | **0** | ❌ **死代码** |
| `ErrorState` | 454 | 12 | ✅ |

`EmptyState`（`index.tsx:445-451`，7 行）**从未被 import**。合计死代码 ≈ **27 行**（含注释块）。

### 8 条 lazy 路由全部可达（CONFIRMED）

`App.tsx:16-23` 的 8 个 `lazy()` 全部在 `App.tsx:62-131` 的 `<Routes>` 中有对应 `<Route>`：
`Overview(/)`, `Credentials(/credentials)`, `AccessKeys(/access-keys)`, `ModelRouter(/model-router)`, `ModelPool(/model-pool)`, `TokenStats(/token-stats)`, `Traffic(/traffic)`, `Ops(/ops/*)`。

导航项 `nav.ts:28-69` 共 10 项，全部指向上述路由的子集（`/ops` 系列 5 项由 `OpsPage.tsx:67-73` 的页内 `Segmented` 承接）。**无孤儿路由，无孤儿导航项。**

构建产物也印证了按路由分包是生效的（`OpsPage-2ytgo4zZ.js` 49.46 kB 独立成 chunk）。

### 前端的问题（CONFIRMED）

1. **`OpsPage.tsx` 1552 行**，内部有 5 个 tab 的全部状态与渲染。`useAsyncData` 被调用 **9 次**（`OpsPage.tsx:105,106,107,108,116,118,145,150,151,152`），**全部 `enabled: !!key`，与当前 tab 无关**。即：打开 `/ops` 一次性发出 runtime + sticky + routeCheck + clientConfig + scheduler + balanceRefresh + taskLog + rotateStatus + rotateSettings + runtimeConfig —— **10 个并发请求**，其中 `getRouteCheck` 在服务端会触发 `pool.explainCandidates`（§3 的 N 次全表写）。切 tab 不减少请求。

2. **`http.ts:61` 的 `inflight` Map 无界**：`inflight.set(cacheKey, p)`，`.finally(() => inflight.delete(cacheKey))`（`http.ts:203-205`）——理论上会清理，但若 `rawRequest` 从未 settle（例如外层没传 signal 且 fetch 挂死），条目永久驻留。`buildSignal` 默认 30s 超时（`http.ts:58,94-100`）兜住了这个风险。**可接受，但 `inflight` 没有大小上限。**

3. **`SummaryProvider.tsx:86-94` 的 `accountsOf` 每次 render 重新 filter**（`useCallback` 依赖 `[data]`）。`AppLayout.tsx:28` 订阅了整个 context，`Clock` 隔离在独立组件（`AppLayout.tsx:10-23`）—— 这一点做得对。

4. **`main.tsx` 只包了一个 `ErrorBoundary`**（`main.tsx:8-14`），`App.tsx` 内没有按路由的 error boundary。任一 feature 组件渲染期抛错 → **整个应用白屏**，只剩 fallback。

5. **`App.tsx:33-34`**：
   ```js
   const [authLost, setAuthLost] = useState(false);
   const setupDone = !!key && !authLost;
   ```
   密钥存 `sessionStorage`（`App.tsx:56` 注释），`App.tsx:41` 的注释说"登录密钥存于 localStorage"——**注释与实现不一致**（`index.js:41` 的 CSP 注释也重复了这个错误说法）。功能上无差别，但 CSP 收紧的理由被写错了。

---

## 8. CONFIG SYSTEM — 7 个配置面，无交叉校验，有幽灵配置

### 配置面清单（CONFIRMED）

| # | 位置 | 加载点 | 优先级 | 校验 |
|---|---|---|---|---|
| 1 | `.env` (dotenv) | `config.js:9` | 最低（文件级） | ❌ 无 schema，`parseInt` 后不校验 NaN |
| 2 | `model-config.json` | `config.js:23` | — | ❌ 无 |
| 3 | `model-fallback.json` | `config.js:27` | — | ❌ 无 |
| 4 | `model-router.json` | `model-router/store.js:16` | 工作区文件 > 仓库模板 | ⚠️ `normalizeProvider`/`normalizeVirtual` 有强制归一 |
| 5 | `.trae-api/scheduler-settings.json` | `scheduler-settings.js:35` | 文件 > env > 默认 | ✅ `lib/settings-store.js:26-70` 有夹紧 |
| 6 | `.trae-api/rotate-settings.json` | `rotate-settings.js:35` | 文件 > env > 默认 | ✅ 同上 |
| 7 | `.trae-api/{notify,balance-refresh,backup}-settings.json` | `lib/settings-store` | 文件 > env > 默认 | ✅ 同上 |
| 8 | SQLite（密钥/账号） | `credentials/db.js` | — | ⚠️ |

### 矛盾点（CONFIRMED）

**a) `model-fallback.json` 完全没有消费者。**
全库 grep `fallbackConfig` 只有 3 处，**全在 `config.js` 内部**：
```
config.js:27   const fallbackConfig = readJson(...)
config.js:111  fallbackConfig,          ← 导出
config.js:182  config.fallbackConfig = freshFallback;  ← 热重载
```
**没有任何模块读取 `config.fallbackConfig`。** 而该文件内容不是空壳——它声明了 `autoFallback: true`、`queueThreshold: 300`、以及 14 组 claude→glm/qwen 的降级映射（`model-fallback.json:1-70`）。**用户以为自己配置了降级策略，实际 `autoFallback` 从未被读取。** 这是最容易造成误判的配置面。

**b) 面板"账号轮换开关"实际可能不生效（CONFIRMED）。**
`OpsPage.tsx:229` 渲染 `s.enabled !== false` —— `s` 来自 `getSchedulerSettings()`（`OpsPage.tsx:116`），即 `scheduler-settings.json`。但该文件的 `SPECS`（`scheduler-settings.js:10-30`）**已删除了 `rotateEnabled`**（`scheduler-settings.js:18-20` 注释说明 m-32 收敛）。因此 `s` 里根本没有 `enabled` 字段 → `undefined !== false` → **开关永远显示为"开"**。
真正的开关在 `rotate-settings.json` 的 `enabled`（`rotate-settings.js:24`）。这是 OpsPage 依然按旧版单文件设置渲染的残留。

**c) `SCHEDULER_ENABLED` 不控制任何东西（CONFIRMED）。**
`config.js:159` 定义 `schedulerEnabled`，`config.js:194` 热重载。
全库 grep：**`index.js:143` 无条件 `scheduler.start()`，无任何地方读 `config.schedulerEnabled`。**
`.env.example` 却把它列为 `SCHEDULER_ENABLED=true` 的正式选项。

**d) `TOOL_PROTOCOL` 是只写不读的配置（CONFIRMED）。**
`config.js:127` 定义，`config.js:204` 热更。
全库唯一消费点：`routes/admin-debug.js:249` —— **只是把它显示在 debug 面板上**。`config.js:126` 的注释"工具调用协议：'native'(默认) | 'text'"暗示了它应该切换协议，实际没有任何代码分支读取它。

**e) 幽灵 env（CONFIRMED）。**
`.env.example` 中以下变量在全 repo（`src/` + `scripts/` + `web/src/`）**零引用**：
- `PROJECTION_ENABLED` / `PROJECTION_MAX_SYSTEM`（"长上下文投影压缩"整节）
- `STATS_CACHE_OFF`（实际生效的是 `STATS_CACHE`，见 `admin-traffic.js:23`）
- `TASK_LOG_MAX_ENTRIES`

**f) `rotate.settings` 的 `intervalMinutes` 是死字段（CONFIRMED）。**
`rotate-settings.js:26` 保留它并注明"已废弃：间隔轮换链已移除，字段保留仅为兼容旧配置文件读取"。该字段有 env（`ROTATE_INTERVAL_MINUTES`）、有 min/max 夹紧、会被 `getEffective()` 返回 —— 但**无人读取**。

**g) `AUTO_CONTINUE` 是功能性放大开关，无上限保护（CONFIRMED）。**
`.env` 实际配置 `AUTO_CONTINUE=<len 4>`（即 `true`），`MAX_CONTINUES=<len 1>`。
`config.js:121-122` 读取。生效点 `openai.js:447,537` —— **只在 `/v1/chat/completions`**。`/v1/messages` 和 `/v1/responses` **完全没有续写**（`anthropic.js` / `responses.js` 无 `autoContinue` 引用）。
→ 同一个上游截断，OpenAI 客户端拿到完整回复，Anthropic 客户端拿到半截 `max_tokens`。**这是一致性缺陷**，且 `.env.example:110-115` 的文档把它描述成全局特性。

### 校验的分布（判断）

- **好的**：`lib/settings-store.js` 的 5 个 Settings 文件有真正的类型强制与 min/max 夹紧，`SPECS` 表驱动，单一实现。`model-router/store.js` 的 `normalize*` 也做了强制归一（含剥离明文 `apiKey`，`store.js:88-92`）。
- **坏的**：`.env` 与 3 个根 JSON **完全没有 schema**。`config.js:92-166` 的 75 行是手写的 `parseInt(process.env.X || '默认')`，**NaN 会静默传播**（例如 `PORT=abc` → `parseInt` 返回 `NaN` → `app.listen(NaN)` 行为未定义）。只有 `config.js:86-88` 的 `API_KEY === ADMIN_KEY` 一条显式校验（且它会 **throw**，是唯一让进程拒绝启动的配置错误）。
- **`config.reload()`（`config.js:174-214`）有 41 行手工重复同一批 `parseInt(process.env... || 默认)`**。初始加载（`config.js:115-166`）与热重载是**两份独立实现**。`config.js:44-47` 的注释承认曾经因为两处实现分叉导致"热重载后丢失 scene / reasoning"，他们用 `makeResolveModelOptions` 修了模型映射，但**其余 20 个字段仍是两份**。例如 `config.port`/`host`/`apiKey`/`adminKey`/`statusPublic` 在 `reload()` 中**没有更新**——注释说这是刻意的（"端口/host/密钥等监听或鉴权级配置不热更"），但 `statusPublic` 被更新了（`config.js:212`）而它是个鉴权级开关（`middleware/auth.js:87`）。**边界不自洽。**

---

## 9. BUILD HEALTH — 构建与 lint 全绿

### `npm run build`（CONFIRMED）

```
> tsc -b && vite build
vite v5.4.21 building for production...
✓ 76 modules transformed.
dist/index.html                     0.60 kB │ gzip:  0.47 kB
dist/assets/index-CBRNcGkK.css     21.86 kB │ gzip:  5.47 kB
dist/assets/stats-DP0LOeWM.js       0.64 kB │ gzip:  0.28 kB
dist/assets/admin-B03ERixv.js       3.18 kB │ gzip:  1.23 kB
dist/assets/PageShell-CSCP2GUT.js   3.43 kB │ gzip:  1.58 kB
dist/assets/accountPacks-D9ylpYaN.js 4.88 kB │ gzip:  2.19 kB
dist/assets/OverviewPage-B448XkwR.js 6.72 kB │ gzip:  2.76 kB
dist/assets/AccessKeysPage-B2YC9wZV.js 7.62 kB │ gzip:  3.30 kB
dist/assets/TrafficPage-ZnjjMmBK.js  8.09 kB │ gzip:  2.95 kB
dist/assets/ModelPoolPage-sKPnCUcQ.js 8.15 kB │ gzip:  3.41 kB
dist/assets/ModelRouterPage-p3w3APcO.js 13.13 kB │ gzip:  4.68 kB
dist/assets/TokenStatsPage-Bx2Zup_1.js 21.12 kB │ gzip:  7.18 kB
dist/assets/CredentialsPage-BMZ7WQD0.js 25.06 kB │ gzip:  8.70 kB
dist/assets/OpsPage-2ytgo4zZ.js     49.46 kB │ gzip: 13.86 kB
dist/assets/index-Bcoc3emJ.js      195.84 kB │ gzip: 64.46 kB
✓ built in 1.11s
```

**exit 0。无警告（无 chunk 大小警告，因为最大 chunk 195 kB < 默认 500 kB 阈值）。**

判断（CONFIRMED）：
- `tsc -b` 通过 → **TypeScript strict 下无类型错误**。
- 首屏 entry 195.84 kB / gzip 64.46 kB（React 18 + react-router + 应用壳）。**对自托管管理面板合理。**
- 路由分包**真实生效**：8 个 lazy 路由各自成 chunk。`OpsPage` 49.46 kB 是最大的 feature chunk（与它 1552 行的体量一致）。
- **`stats-DP0LOeWM.js` (0.64 kB) 与 `admin-B03ERixv.js` (3.18 kB) 是 API 层的共享 chunk**，被多个 page chunk 引用。
- **没有 sourcemap 配置验证**：`vite.config.ts` 未在本审查中读取，但默认 production 无 sourcemap。生产环境出问题时无法定位。

### `npm run lint`（CONFIRMED）

```
> eslint .        → 无输出，exit 0
```

ESLint 9 flat config + `typescript-eslint` + `react-hooks` + `jsx-a11y`（`web/package.json:26-31`）。**零警告零错误**。

判断：配置了 `jsx-a11y`（无障碍）与 `react-hooks`（hook 依赖）插件且全绿，是**真实的质量门**而非 `eslint .` 的空跑——`shared/ui/index.tsx:128,135,147,162` 的 `aria-label`/`role="group"` 与 `Stepper` 的实现说明 a11y 规则确实在约束代码。

### 后端 lint（CONFIRMED，缺失）

`package.json:9` `"lint": "npm --prefix web run lint"` —— **只 lint 前端**。`src/` 108 个文件**没有任何 linter、formatter 或 TS 检查**。`package.json` 里没有 eslint/prettier 作为 root devDependency。

这对一个 108 文件、无 TypeScript 的 Node 后端是显著缺口：`store.update` 传错字段名、`pool.record` 传错 kind 字符串（`'5xx'` vs `'5XX'`）这类错误，编译期与 lint 期都不会被捕获，只能靠 `unit.test.js` 覆盖到。而 §6 已证明 route 层零覆盖。

---

## 10. STARTUP CHAIN — 降级而非崩溃，但降级是静默的

### 启动序列（`index.js`，CONFIRMED）

```
1.  require('./log/crash').install()        index.js:8     ← 最先，捕获模块加载期异常
2.  require express + 12 个 route 模块       index.js:15-36 ← 加载期异常已被 1 捕获
3.  express.json({limit:'10mb'})            index.js:39
4.  CSP/安全头中间件                          index.js:59-65
5.  /health（不打 DB？→ 打！见下）             index.js:69-79
6.  app.use(status) + dashboard              index.js:81-82
7.  若 web/dist 存在 → static + SPA fallback  index.js:85-93
8.  管理面 8 个 mount                         index.js:95-107
9.  /v1/models 双面 mount                     index.js:111-112
10. authenticate + rateLimit → openai/anthropic/responses  index.js:113-117
11. 404 + 错误中间件                           index.js:120-128
12. bootstrapFromEnv() + ensureModelsReadScope()  index.js:169-183  ← try/catch 吞掉
13. listen(port, host, ['::','127.0.0.1'])   index.js:184
14.   └─ listen 回调内：scheduler.start() + initCredentials()
        + balance-refresh.start() + backup.start() + zcode-rewards.start()
        + retention.pruneAtStartup()          index.js:143-153
```

**关键：第 14 步的所有副作用都在 `app.listen` 的 success 回调里。** 意味着**端口绑定成功之前，DB 首次访问、调度器、备份全部未启动**。反过来讲，端口绑定是启动链条上唯一的硬前提。

### 各失败模式的实际表现

| 场景 | 表现 | 证据 |
|---|---|---|
| **`.env` 缺失** | ✅ **正常降级**。`dotenv.config()` 静默返回 error，`config.js` 全部字段走 `\|\| 默认`。**但**：`config.js:83-85` 打印 `[config] ADMIN_KEY 未设置` 后继续；`credentials/api-keys.js:377` 不再创建 bootstrap-login。→ 若 DB 里也没有 login key，面板 `SetupGate` 会强制走首次 setup。**这是设计好的路径。** | `config.js:9`, `config.js:83-88` |
| **`.env` 中 `API_KEY === ADMIN_KEY`** | ❌ **进程崩溃**（唯一一类）。`config.js:86-88` `throw new Error(...)`。因为 `config.js` 在 `require('./log/crash').install()` 之后加载（`index.js:8` → `index.js:13`），**该 throw 发生在模块加载期，被 `uncaughtException` 捕获并写入 `logs/<date>/crash.jsonl`，然后 `process.exit(1)`**（`crash.js:56-65`）。start.bat 记录 errorlevel 并退出。✅ **失败可见。** | `config.js:87`, `crash.js:56-65` |
| **数据库损坏/无法打开** | ⚠️ **取决于损坏位置**。`db.js:196-197` `mkdirSync` + `new DatabaseSync(DB_FILE())`。若文件是无效 SQLite，`DatabaseSync` 构造**同步 throw**。调用链：`db()` ← `store.list()` 或 `apiKeys.bootstrapFromEnv()`。**第 12 步被 `index.js:181-183` 的 `try/catch` 吞掉**（只 `console.error('[api-keys] bootstrap failed:', e.message)`）。**但该 catch 只包住 bootstrap**——`ensureSchema` 从未在这个 try 里跑过，之后每个请求的第一次 `db()` 调用都会再次 throw。**result：进程启动成功、端口监听成功、调度器全部启动，但每一个需要 DB 的请求都 500。** `/health` 也会 500（见下）。**静默半死状态。** | `db.js:194-203`, `index.js:169-183` |
| **`model-config.json` 损坏/缺失** | ⚠️ **静默降级**。`config.js:11-19` `readJson` catch 后 `console.error('[config] Failed to read ...')` 并返回 fallback `{models:{},settings:{}}`。→ `MODEL_MAP` 只有 `auto`。**所有物理模型名都会走 `config.js:67` 的兜底分支**（`function:'chat_v3'`, `config_name: 原样透传`）。进程正常服务，只是行为改变。而 `openai.js:97` 的 `inLocalTraeModels()` 会因为 `models` 为空而对 WB 模型误判。**用户看到的是"服务在跑但模型都不对"。** | `config.js:11-19, 23-25, 67` |
| **`model-router.json` 损坏** | ⚠️ **静默降级到空**。`model-router/store.js:55-59` catch → `cache = emptyConfig()`（只有 trae/workbuddy 两个 provider，`virtualModels:{}`）。→ **所有虚拟模型消失**，`hasVirtualModel()` 对任何 `vm/*` 返回 false（`model-router/index.js:32-35`），→ 请求落到 `openai.js:228` 的物理模型分派，`vm/xxx` 被当物理模型名发给上游 → 上游 400。**面板仍显示"路由正常"。** | `store.js:45-60` |
| **`web/dist` 不存在** | ✅ **静默跳过**。`index.js:85` `if (fs.existsSync(webDist))`。→ 面板 404，但 `/v1/*` 转发面完全正常。**这是正确的降级**（转发面与面板解耦）。 | `index.js:84-93` |
| **上游全下线** | ✅ **降级**。启动不探测上游（无 boot-time health check）。请求时 `pool.run` → `pool.js:657-666`：`pick` 返回 null → `nextAvailableIn` 若返回非 null 则入队等待（最长 30s），否则 `alertIfPoolEmpty()` + `break` → 最终 `pool.js:694-697` 抛 `POOL_UNAVAILABLE` / status 429。**客户端拿到可重试的 429 而非 500。** ✅ | `pool.js:655-698` |
| **`encrypt.key` 丢失** | ❌ **不可逆数据丢失**。`lib/crypto.js:51` 无 key 文件时 `crypto.randomBytes(32)` 生成新 key 并落盘。→ **所有既有账号 token 无法解密**。`crypto.js:38-39` 的注释明确说了这个风险，`crypto.js:41-49` 也做了旧位置回退复制。**但没有任何启动期校验**（例如：DB 里有密文行但 key 是新生成的 → 应该拒绝启动）。首次解密失败发生在请求路径上。 | `crypto.js:34-58` |

### `/health` 也会因 DB 挂掉（CONFIRMED）

`index.js:69-79`：
```js
app.get('/health', (req, res) => {
  const s = status.buildStatus();     // ← status.js:19  store.list() → db()
  res.json({ status: 'ok', ... });
});
```
`status.js:19` 调 `store.list()`，**直接打 DB**。DB 异常时 `buildStatus()` 同步 throw → 被 `index.js:125-128` 的错误中间件捕获 → **500 `{error:{type:'internal_error'}}`**。

更糟的是：**`res.json({status:'ok', ...})` 中的 `'ok'` 是硬编码字符串**，它不反映任何实际健康度。它只报 `accounts`、`uptime`、`scheduler.enabled`、`poolStrategy`。**这不是 health check，是 uptime 探针。** 服务管理器（srvany）无法据此判断"要不要重启"。

### 启动期的两个具体隐患（CONFIRMED）

1. **`retention.pruneAtStartup(config.ROOT)`（`index.js:152`）在 listen 回调内同步执行**：`log/retention.js` 会遍历 `logs/` 下的日期目录并 `rmSync`。若日志目录巨大，这一步**在事件循环上同步阻塞**，且发生在 `scheduler.start()` 之后、`console.log('[relay-gate] periodic jobs started')` 之前。顺序上是"先启动定时任务，再删日志"，语义反了（应先清理再启动）。
2. **`index.js:145` `initCredentials()` 在 listen 回调内同步跑 `ensureAllMissingDevices()`**（`credentials.js:63-72`），对每个缺 devices 的账号做写操作。账号多时这会**延长"端口已 LISTEN 但业务未就绪"的窗口**——客户端在此窗口内发起的请求会进入 `pool.pick()` → `store.list()`，与 backfill 的写竞争。

### 值得肯定的（对比之下）

- `index.js:130-164` 的 `listen()` **原地重试绑定**（fallback 链 `['::','127.0.0.1']`），且对 Windows 上 vmnat 占用 `0.0.0.0` 的现实做了处理（`index.js:140-142` 的 IPv6 警告）。这是经过实战的。
- `crash.js:8` 的安装时机（**在业务模块 require 之前**）是正确的，模块加载期异常确实会被记录。
- `crash.js:63-64` 的 "未捕获异常后进程状态不可信，记录后退出" 是正确的取舍——`process.exit(1)` 而非硬撑。
- `start.bat:44-64` 的孤儿 node 清理（netstat + tasklist CSV + `%%~` 去引号比对）是细致且正确的；注释解释了为什么放弃 PowerShell 版本（26s → 换成纯 cmd）。

---

## 附：值得单独记录的细节缺陷

按可操作性排序，均为 CONFIRMED：

1. **`transform/emitters.js:62` `exportAnthropic().start()` 返回 `[]`**，注释说"message_start 由路由层控制更精细"。实际路由层（`anthropic.js:119`）**手写了这个事件**。→ `exportAnthropic` 不是完整发射器，接口不对称。

2. **`anthropic.js:145` `streamAccountId = accountId` 在 `pool.run` **返回后**赋值**：
   ```js
   const { result: up, accountId } = await pool.run(...);
   streamAccountId = accountId;     // :145
   ```
   但流内 error 的处理在 `handler` 回调（`anthropic.js:134`）：
   ```js
   if (isRateLimitCode(evt.code) && streamAccountId) pool.record(streamAccountId, 'rate_limit', ...);
   ```
   `streamAccountId` 在 `pool.run` resolve 时才有值，而 `handler` 的 error 事件正是 **pool.run 的 fn 内部**通过 throw 传播的——**此时 `streamAccountId` 仍是 `null`**。→ **`/v1/messages` 的流内限流错误永远不会回灌账号池。**（对比 `openai.js:418` 直接用闭包里的 `accountId` 参数，是正确的。）

3. **`responses.js:163` 同样的 bug**：`streamAccountId` 从 `pool.run` 解构后赋值（`responses.js:125`），catch 里用（`responses.js:163`）——**catch 在 pool.run 之后，所以这里是对的**。只有 anthropic 把 record 放在了 handler 回调里，构成 bug。**三者行为不一致。**

4. **`upstream/client.js:224` 的 `requestTimeoutMs` 默认 600000（10 分钟）作用于整个流**：
   ```js
   const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
   ```
   `clearTimeout(timer)` 在 `client.js:243` —— 即 **fetch 返回响应头后定时器就被清掉了**，**流式读取阶段没有超时保护**。`consumeStream`（`client.js:405-427`）的 `reader.read()` 可以永久挂起。→ **上游中途静默停发数据时，连接会一直挂着**，客户端与 `pool` 的 `inFlight` 租约都不会释放。这是一个**真实的资源泄漏路径**（NEEDS-CONFIRMATION：需确认上游是否真会中途静默）。

5. **`lib/sse-lines.js` 只有 37 行**却被 4 个模块 require —— 说明"跨 chunk 残行"这个正确性问题被识别并修复过，但只修了这一层，上游流生命周期（cancel/timeout）没有被同等对待。

6. **`routes/models.js:9` `getModelDetailParam` 在 `upstream/client.js:279-303` 中**不经过 `pool`、不带账号池的冷却/限流**（`client.js:280` `auth.ensureAuth()` 不传 `accountId` → 取"第一个 enabled 账号"）。→ **一个 admin 接口可以反复打同一个账号，绕过全部出站节流。**

7. **`middleware/rate-limit.js:43-47` 的清理逻辑有缺陷**：
   ```js
   if (windows.size > 5000) {
     for (const [k, v] of windows) {
       if (!v.length || now - v[v.length - 1] > 60_000) windows.delete(k);
     }
   }
   ```
   只在 size > 5000 时清理，且 `v[v.length-1]` 是**最后**一个时间戳（最新），不是最旧的——所以判据实际是"该 key 最近 60s 内无请求"。逻辑上正确但**触发条件依赖 size 突破 5000 才跑一次 O(n)**，单次清理可能清不掉多少。可以接受，但是个粗略实现。

---

## 结论摘要

**架构层面：** 后端声称的四层（routes→transform→upstream→credentials）只在注释里成立。真实形态是"**三个转发路由各自持有一份完整的协议处理骨架**"，`transform/` 只抽象了最内层的事件归一化。这直接导致 §1 表格中列出的 8 类行为在 4 个出口之间分叉（finish_reason 语义、错误帧形态、markIncomplete 常量、续写支持）。

**可靠性层面：** 最严重的两个缺口是 (a) **`store.update` 的全列读-改-写 + `pool.pick` 的 TOCTOU**，在任何并发管理面写入下会静默损坏调度状态；(b) **没有优雅停机**，唯一的信号处理器在 flush 任何东西之前 `process.exit(0)`。这两个都是**在正常使用下就会触发**的，不需要极端条件。

**测试层面：** 288 个断言全绿是真实的，覆盖广度（依赖方向不变量、zcode 全套、并发竞态的单进程版本）超出同类个人项目水平。但**产品核心路径——三个转发协议的字节级正确性、SSE 中途失败、任何形式的并发写——零覆盖**。构建（`tsc -b` + `vite`）与前端 lint 全绿；**108 个后端文件无任何静态检查**。

**待确认项（需要运行期验证）：** §4 的"流中途 3004 导致重复 role 帧"是否可达；§3 的 27ms/次 `store.list()` 在真实账号规模下的停顿幅度；§10 的 `reader.read()` 永久挂起是否在上游实际发生；§5 的轮换在当前 Session 0 部署下是否真的能成功拉活客户端（代码注释倾向"不能"）。
