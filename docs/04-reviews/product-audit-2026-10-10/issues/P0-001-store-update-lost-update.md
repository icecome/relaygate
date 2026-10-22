# P0-001 — `store.update()` 读-改-写导致跨进程丢失更新

| 字段 | 值 |
|---|---|
| **Priority** | P0 |
| **Category** | 架构 / 数据完整性 |
| **Labels** | `bug`, `data-integrity`, `p0`, `backend` |
| **Difficulty** | 中（约 3 小时） |
| **Risk** | 中（改动的是核心写路径，必须配测试） |
| **来源** | product-professor full audit 2026-10-10 |

---

## Evidence

[src/credentials/store.js:206-231](../../../../src/credentials/store.js#L206-L231)：

```js
function update(id, patch) {
  const existing = get(id);            // ← 全列读取
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  const r = acctToRow(merged);
  db().prepare(`
    UPDATE accounts SET
      label = ?, edition = ?, token_enc = ?, ... (共 34 列)
  `).run(...);
}
```

**无版本列、无事务、无 CAS。** 任何另一写入方在 `get()` 与 `UPDATE` 之间写入的字段会被陈旧快照覆盖回去。

### 已知触发路径

1. [pool.js:422](../../../../src/credentials/pool.js#L422) `store.list()` 读全表快照 → [pool.js:487](../../../../src/credentials/pool.js#L487) `store.update(chosen.id, { lastPickedAt })` 用该快照写回**全部 34 列**。
2. 面板在 [CredentialsPage.tsx:141](../../../../web/src/features/accounts/CredentialsPage.tsx#L141) 调 `PATCH /v1/credentials/:id {enabled}` 走 [routes/credentials.js:264](../../../../src/routes/credentials.js#L264) → 同样进 `store.update`。
3. `scripts/login-key.js` 等第二个 node 进程同时打开同一个 DB 文件。

### 加重项：只读接口在写库

[pool.js:725](../../../../src/credentials/pool.js#L725) 与 [pool.js:750](../../../../src/credentials/pool.js#L750)：

```js
if (pruned) store.update(a.id, { modelCooldowns: pruned });
```

这两行位于 `explainCandidates()` 与 `snapshot()` 这两个**只读**函数里，对**每个账号**做一次全列 UPDATE。`GET /v1/admin/runtime`（[admin-overview.js:125](../../../../src/routes/admin-overview.js#L125)）与 `GET /status`（[status.js:28](../../../../src/routes/status.js#L28)）都会触发。**`/status` 在 `STATUS_PUBLIC=true` 时免鉴权** —— 一个 GET 请求产生 N 次数据库写。

---

## 严重性机制修正（重要）

架构审查员最初判为"跨 `await` 窗口的 TOCTOU"。**经独立复核，该描述不准确**：

- [`pick()` 全文（417-490 行）无 `async`、无 `await`](../../../../src/credentials/pool.js#L417-L490) ✅ 已核实
- `node:sqlite` 的 `DatabaseSync` 是**同步** API（[db.js:10,194-197](../../../../src/credentials/db.js#L194-L197)）✅ 已核实

→ **单进程内不存在异步窗口。** 真实风险是：
1. **跨进程**（同一 Windows 账户下第二个 node 进程，例如运维手动跑脚本）
2. **多客户端同时写库**

严重性仍是 **P0**（数据静默回滚是真实不变量破坏），但修复方案应针对"丢失更新"，而非"竞态条件"。

---

## Why it matters

- 丢失更新是**静默**的：没有错误、没有日志、没有异常。用户只会发现"我明明改了优先级，它自己变回去了"。
- 被覆盖的字段包括 `enabled`、`priority`、`coolUntil`、`errorCount`、`lastPickedAt` —— **调度状态**。被回滚的 `lastPickedAt` 会让同一个账号被反复选中（或永远不被选中）。
- 表格中被覆盖的还有 `token_enc` / `refresh_token_enc`：一次跨进程覆盖足以让刚刷新的 token 回退成旧值。

---

## Expected behavior

- 任何一次写入只影响它声称要改的字段。
- 并发写入同一账号的不同字段时，两者最终都生效。
- 冲突可被检测并重试，而不是静默丢弃。

---

## Acceptance criteria

1. 新增 `src/test/store-concurrency.test.js`，构造「A 改 enabled、B 改 priority」两个并发的 `update()`，断言**最终两个字段都是新值**（当前实现下该测试应失败）。
2. 子进程测试：主进程读快照 → 子进程写 `priority=5` → 主进程写 `enabled=false`，断言 `priority` 仍为 5。
3. `pool.js:725` 与 `pool.js:750` 不再调用 `store.update`；对 `GET /v1/admin/runtime` 与 `GET /status` 各请求一次，断言 accounts 表**零写入**（可用 sqlite `total_changes()` 或临时 hook 验证）。
4. 现有 288 个断言全部继续通过，`npm test` exit 0。

---

## Implementation notes

1. `db.js` 的 `ensureSchema` 增加 `version INTEGER NOT NULL DEFAULT 0` 列（沿用文件里已有的幂等 ALTER 模式，见 [db.js:19-192](../../../../src/credentials/db.js#L19-L192)）。
2. `store.js` 新增 `buildSetClause(patch)`：只把 `patch` 中出现的键映射为 SET 子句，而不是固定 34 列。注意 `acctToRow` 当前是全列映射，需要复用其列名映射但按需裁剪。
3. `update(id, patch)` 改为：
   ```sql
   UPDATE accounts SET <patch 列>, version = version + 1
   WHERE id = ? AND version = ?
   ```
   `changes === 0` 时重读 + 重试（上限 3 次），仍失败则抛出带 `code: 'WRITE_CONFLICT'` 的错误。
4. `pool.js:725` / `:750` 的 `modelCooldowns` 裁剪结果改为**返回值**交给调用方；真正的落库下沉到 `jobs/balance-refresh.js` 或 `pool` 的定时清理里。

---

## 可直接执行的修复提示词

```
修复 src/credentials/store.js 的 update() 丢失更新问题。

现状：update(id, patch) 是「get(id) 全列读 → merge → UPDATE 全部 34 列」，
无版本保护、无事务、无 CAS。任何并发的另一写入方在 get 与 UPDATE 之间写入的字段
会被陈旧快照覆盖回去。

注意：node:sqlite 的 DatabaseSync 是同步 API，pick() 内部也没有 await，
所以问题不表现为单进程内的竞态，而是「跨进程」与「多客户端同时写库」两种场景。
测试要按这个来构造。

请执行：
1) src/credentials/db.js 的 ensureSchema 增加 version INTEGER NOT NULL DEFAULT 0 列
   （沿用该文件已有的幂等 ALTER 模式）。
2) src/credentials/store.js：
   - 新增 buildSetClause(patch)，只把 patch 中出现的键映射为 SET 子句（不要固定 34 列）。
   - update(id, patch) 改为条件更新：UPDATE ... SET <patch 列>, version = version + 1
     WHERE id = ? AND version = ?；changes === 0 时重读并重试，上限 3 次，
     仍失败抛 code: 'WRITE_CONFLICT' 的错误。
3) src/credentials/pool.js:725 与 :750：explainCandidates / snapshot 这两个只读函数
   不再调用 store.update。把 modelCooldowns 的裁剪结果返回给调用方，
   落库下沉到 jobs/balance-refresh.js。
   理由：GET /v1/admin/runtime 与 GET /status 会触发这两个函数，
   而 /status 在 STATUS_PUBLIC=true 时免鉴权 —— GET 不应产生数据库写。
4) 新增 src/test/store-concurrency.test.js：
   - 用例 A：A 改 enabled、B 改 priority，断言两者最终都生效
   - 用例 B：子进程写 priority → 主进程写 enabled，断言 priority 未被回滚
   - 用例 C：GET /v1/admin/runtime 后 accounts 表 total_changes 增量应为 0
5) 运行 npm test，确认 288 个既有断言 + 新用例全部通过，exit 0。

不要修改 API 契约（routes 层调用签名保持不变）。
```