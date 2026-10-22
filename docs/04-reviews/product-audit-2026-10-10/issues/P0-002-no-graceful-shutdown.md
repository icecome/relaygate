# P0-002 — 无优雅停机 + 定时任务无跨进程防重

| 字段 | 值 |
|---|---|
| **Priority** | P0 |
| **Category** | 可靠性 |
| **Labels** | `bug`, `reliability`, `p0`, `backend`, `shutdown` |
| **Difficulty** | 中（约 2 小时） |
| **Risk** | 低（新增路径，不改现有行为） |
| **来源** | product-professor full audit 2026-10-10 |

---

## Evidence

### 1. 唯一的信号处理器在 flush 之前退出

[src/log/crash.js:78-83](../../../../src/log/crash.js#L78-L83)（已实读复核）：

```js
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    writeEvent({ tag: 'lifecycle', event: 'signal', signal: sig });
    process.exit(0);          // ← 立即退出
  });
}
```

`src/index.js` 全文：
- **无 `server.close()`**
- **无任何 shutdown 钩子**
- **无 `db.close()`**

### 后果（用户可见）

| 症状 | 原因 |
|---|---|
| 客户端报"连接被重置" | 在途 SSE 被硬切，无 error 帧、无 finish_reason |
| 停机后 stats-cache / sticky / 池冷却状态全丢 | 内存态从不持久化，也不 flush |
| Windows 服务管理器停止服务时无任何确认 | 5 秒内进程直接消失 |

### 2. 定时任务无跨进程防重

[src/index.js:143](../../../../src/index.js#L143) `scheduler.start()` 每次进程启动无条件排程：
- 无 pidfile、无文件锁、无"上次运行时刻"持久化
- [scheduler.js:39](../../../../src/jobs/scheduler.js#L39) 的 `scheduleEpoch` 只解决**进程内**重排
- `start.bat` 自身注释承认可能出现 "two schedulers run side by side"

**签到重复是幂等的**（今天签过就返回已签）。但以下任务**非幂等**：
- 备份（重复执行产生冗余文件，尚可接受）
- **账号轮换**（重复触发会让 WorkBuddy 客户端在账号间反复横跳）
- **ZCode 奖励领取**（有上游风控风险）

---

## Why it matters

- 这是**每晚都会经过的路径**：Windows 计划任务或服务管理器每天至少启停一次进程。
- P0 定级依据：`process.exit(0)` 在 `writeEvent` 之后、**任何 flush 之前**执行——即停机时丢失的正是"最后一次状态"，而这恰恰是排障时最需要的那部分。
- 跨进程双调度器是**真实会发生的**：`start.bat` + 手动 `node src/index.js` 同时跑。

---

## Expected behavior

1. 收到 SIGTERM/SIGINT 后：
   - 停止接受新连接
   - 停止所有定时器
   - 在途请求有最多 5 秒完成窗口，超时强制退出
   - SQLite 连接被显式 close
   - 退出码 0，日志有 lifecycle 记录
2. 同一时刻最多一个调度器在运行（跨进程）。
3. 重复触发非幂等任务（备份/轮换/ZCode）有保护。

---

## Acceptance criteria

1. 新增 `src/test/shutdown.test.js`：
   - 发送 SIGTERM 后断言：`scheduler.stop()` 被调用、DB `close()` 被调用、在途任务不再新建
   - 断言退出码 0
2. 手动验证：`start.bat` 运行中按 Ctrl+C，控制台出现"shutting down"序列且无 unhandled rejection。
3. 并发启动两个进程，第二个进程的调度器不启动（日志出现"another instance holds the lock"或等效），HTTP 层仍可启动或明确退出。
4. 现有 288 断言全部通过。

---

## Implementation notes

1. `crash.js`：把 `process.exit(0)` 改为导出并调用 `async shutdown(signal)`，加 5 秒超时兜底。
2. `index.js` 的 shutdown 链（按序）：
   ```
   server.close()            → 停止接受新连接
   scheduler.stop()          → 若无则补
   balance-refresh.stop()    → 若无则补
   backup.stop()             → 若无则补
   zcode-rewards.stop()      → 若无则补
   writeEvent(lifecycle)     → flush 日志
   db.close()                → db.js 新增 close()
   process.exit(0)
   ```
3. 跨进程锁：`output/.trae-api/scheduler.lock`，写 PID；启动时检查 PID 是否存活（`process.kill(pid, 0)`），或用 lock 文件 + mtime 心跳。锁获取失败时**调度器不启动**（HTTP 层可继续，或明确退出——推荐后者，避免静默半死）。
4. 可选：对非幂等任务（backup/rotate/zcode）在任务入口加"上次运行时刻"检查（读 task-log 最近一条同任务记录，间隔 < 阈值则跳过并写 `skipped` 事件）。

---

## 可直接执行的修复提示词

```
为 RelayGate 实现优雅停机与跨进程防重。

现状：
- src/log/crash.js:78-83 的 SIGTERM/SIGINT 处理器在 writeEvent 之后立刻 process.exit(0)。
- src/index.js 全文无 server.close()、无任何 stop()、无 db.close()。
- src/index.js:143 scheduler.start() 每次启动无条件排程，无 pidfile/文件锁/上次运行时刻持久化。
  start.bat 自己的注释承认可能出现「two schedulers run side by side」。
- 备份/账号轮换/ZCode 奖励领取是非幂等任务，重复触发有真实副作用。

请执行：

1) src/log/crash.js：
   把 process.exit(0) 改为调用导出的 async shutdown(signal)，
   并给 5 秒超时兜底（超时则 console.error 后 process.exit(1)）。

2) src/index.js 实现 shutdown 链，按序：
   a) server.close() 停止接受新连接
   b) 依次调用 scheduler.stop() / balance-refresh.stop() / backup.stop() / zcode-rewards.stop()
      —— 若这些模块还没有 stop()，需要在各模块内补上（清除各自的 timer 与运行标志）
   c) writeEvent({tag:'lifecycle', event:'shutdown', signal})
   d) 调用 db.close()（src/credentials/db.js 需新增 close()，内部 close _db 并置 null）
   e) process.exit(0)

3) 跨进程防重：新增 output/.trae-api/scheduler.lock（写 PID）。
   scheduler.start() 时：若 lock 存在且其中 PID 存活（process.kill(pid,0) 不抛），
   则打印 '[scheduler] another instance holds the lock (pid X), not starting' 并 return false；
   进程退出（shutdown 链）时删除 lock。
   若 HTTP 服务因端口占用而 fallback 重试，lock 逻辑要跟随最终监听成功的那次启动。

4) 新增 src/test/shutdown.test.js（参照 src/test/unit.test.js 的 WORKSPACE_DIR 隔离方式）：
   - 用例 1：手动构造 scheduler 运行态 → 调 shutdown → 断言 stop 被调、lock 被删
   - 用例 2：lock 中写入一个存活 PID → scheduler.start() 返回 false
   - 用例 3：lock 中写入一个已死 PID → scheduler.start() 正常启动并接管 lock

5) 运行 npm test 确认 288 个既有断言 + 新用例全部通过，exit 0。
6) 手动验证：start.bat 运行中 Ctrl+C，控制台出现 shutdown 序列且无 unhandled rejection。
```