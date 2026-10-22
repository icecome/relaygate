# P2-002 — `model-fallback.json` 无消费者 + 幽灵 env

| 字段 | 值 |
|---|---|
| **Priority** | P2 |
| **Category** | 配置 / 可维护性 |
| **Labels** | `bug`, `config`, `p2`, `backend`, `ghost-config` |
| **Difficulty** | 低（删除 1 小时；实现 4 小时） |
| **Risk** | 低（若选删除方案） |
| **来源** | product-professor full audit 2026-10-10（**evidence-verifier 独立复核确认**） |

---

## Evidence（经独立复核）

### 发现 1：`model-fallback.json` 完全没有消费者

**复核方法**：grep 全部 `src/**/*.js` 中的 `fallbackConfig` 与 `model-fallback`。

**结果**：

| 文件:行 | 用途 |
|---|---|
| [config.js:27](../../../../src/config.js#L27) | `const fallbackConfig = readJson(path.join(ROOT, 'model-fallback.json'), {})` — **读入** |
| [config.js:111](../../../../src/config.js#L111) | 挂到 `config.fallbackConfig` — **暴露** |
| [config.js:182](../../../../src/config.js#L182) | `config.fallbackConfig = freshFallback` — reload 时**重读** |
| [backup.js:170](../../../../src/jobs/backup.js#L170) | 备份该文件 |
| [backup.js:482](../../../../src/jobs/backup.js#L482) | 恢复该文件 |
| [admin-debug.js:259](../../../../src/routes/admin-debug.js#L259) | 注释（reload 端点说明） |

**→ 无任何业务代码消费 `config.fallbackConfig`。** 没有一处 `if (fallbackConfig...)`、没有一处降级映射查表、没有一处 `autoFallback` 判定。

**而该文件的内容是**：

```json
{
  "autoFallback": true,
  "queueThreshold": 300,
  "mappings": { ...14 组 claude→glm/qwen 映射... }
}
```

**用户会花时间配置一个从未生效的降级策略。** 这不是"未使用的死代码"——它是一个**主动误导用户的配置文件**。

### 发现 2：幽灵 env（经复核确认）

| 变量 | 全库引用 | 结论 |
|---|---|---|
| `PROJECTION_ENABLED` | **0** | 幽灵 |
| `PROJECTION_MAX_SYSTEM` | **0** | 幽灵 |
| `STATS_CACHE_OFF` | **0** | 幽灵（真正生效的是 `STATS_CACHE`） |

三者都写在 [.env.example](../../../../.env.example) 里，被文档化为可用开关。

### 发现 3：修正审查员的误判（诚实标注）

架构审查员原报告把以下两项也列为幽灵，**经独立复核为误判**：

| 变量 | 复核结果 |
|---|---|
| `TASK_LOG_MAX_ENTRIES` | ✅ **真实消费**：[task-log.js:17](../../../../src/jobs/task-log.js#L17) `const MAX_ENTRIES = Number(process.env.TASK_LOG_MAX_ENTRIES) \|\| 500;` |
| `SCHEDULER_ENABLED` | ✅ **真实消费**：[scheduler.js:606](../../../../src/jobs/scheduler.js#L606) `if (started \|\| !config.schedulerEnabled) return;` |

**这两项不要删。**

### 发现 4（需确认）：`TOOL_PROTOCOL`

唯一消费点是 [admin-debug.js:249](../../../../src/routes/admin-debug.js#L249)（只在 debug 面板显示）。**是否有行为分支取决于实现**，标注为 needs-confirmation。

### 附：配置面总体状况

7 层配置，无 schema、无交叉校验：

```
.env → model-config.json → model-fallback.json → model-router.json
    → .trae-api/scheduler-settings.json → rotate-settings.json
    → notify-settings.json / balance-refresh.json / backup-state.json / zcode-settings.json
```

且 [config.js:174-214](../../../../src/config.js#L174-L214) 的 `reload()` 与初始加载是**两份独立的解析代码**（注释自承曾因此丢失 scene/reasoning 字段）。`parseInt` 的 NaN 静默传播（唯一显式校验是 [config.js:86-88](../../../../src/config.js#L86-L88) 的 `API_KEY===ADMIN_KEY` throw）。

---

## Why it matters

**一个"配了但不生效"的配置文件，比没有这个文件更糟。** 它消耗用户的配置时间，并在他需要降级时（上游挂了）让他相信系统会兜底 —— 而实际上不会。

幽灵 env 的问题类似但更轻：用户以为自己关掉了某个功能，实际没有。

两者都是"AI 生成了完整的配置面，但没接上消费端"的典型残留。

---

## Expected behavior

**二选一，不要留中间态：**

- **方案 A（推荐）**：删除 `model-fallback.json` 与 `fallbackConfig` 的全部引用；启动时若检测到该文件存在，打一条明确的警告日志（"检测到 model-fallback.json，但本版本不支持模型降级，该文件不会被读取"）。
- **方案 B**：真正实现它 —— 在选模型/选号逻辑里使用 `fallbackConfig.mappings`，在 `/ops/config` 展示当前降级链与命中次数。

幽灵 env 一律从 `.env.example` 删除（或实现）。

---

## Acceptance criteria

**方案 A：**

1. `src/` 中不再有 `fallbackConfig` 的业务引用（`config.js` 的三处引用被删除）。
2. `model-fallback.json` 被删除，或保留但启动时打警告。
3. `.env.example` 中删除 `PROJECTION_ENABLED`、`PROJECTION_MAX_SYSTEM`、`STATS_CACHE_OFF` 三行。
4. `.env.example` 中 `TASK_LOG_MAX_ENTRIES` 与 `SCHEDULER_ENABLED` **保留**（它们是真的）。
5. `npm test` 288 断言全部通过。
6. 确认 `TOOL_PROTOCOL` 是否有行为分支：有则保留并文档化，无则从 `.env.example` 移除。

---

## Implementation notes

1. **删除 `model-fallback.json` 前先确认**：`git log` 查它是什么时候加的、有没有 commit message 说明用途。若曾经有实现后被移除，优先方案 A。
2. **`config.reload()` 的两份解析代码**（[config.js:174-214](../../../../src/config.js#L174-L214)）是另一个独立问题（本次未单列 issue）：建议后续抽出 `makeResolveModelOptions` 之外的统一解析函数，消除 reload 与初始加载的分叉。这是 P3 级别的技术债。
3. **`STATS_CACHE` vs `STATS_CACHE_OFF`**：确认真正生效的是 `STATS_CACHE`（[admin-traffic.js](../../../../src/routes/admin-traffic.js) 与 [stats-cache.js](../../../../src/log/stats-cache.js) 中的判定），然后把 `.env.example` 里那行改为 `STATS_CACHE=off`。

---

## 可直接执行的修复提示词

```
清理 RelayGate 的幽灵配置。已核实的事实（不要重新调查）：

1) src/config.js:27 读入 model-fallback.json → config.js:111 挂到 config.fallbackConfig
   → config.js:182 reload 时重读。除此之外全库无任何业务代码消费 config.fallbackConfig
   （只有 backup.js 把它当文件备份、admin-debug.js:259 是注释）。
   但该文件声明了 autoFallback:true、queueThreshold:300 和 14 组 claude→glm/qwen 降级映射
   —— 用户会花时间配一个从不生效的策略。

2) 幽灵 env（全库 0 引用）：PROJECTION_ENABLED、PROJECTION_MAX_SYSTEM、
   STATS_CACHE_OFF（真正生效的是 STATS_CACHE）。

3) 注意：TASK_LOG_MAX_ENTRIES（task-log.js:17 消费）与
   SCHEDULER_ENABLED（scheduler.js:606 消费）是真实生效的，不要删。

请执行：

【第一步：确认】
git log --oneline -- model-fallback.json
看它的 commit message 是否说明"计划实现降级"。如果没有明确的近期计划，
走删除方案；如果有，走实现方案。

【方案 A（推荐）：删除】
1) 从 .env.example 移除 PROJECTION_ENABLED、PROJECTION_MAX_SYSTEM 两行及其注释块
   （「长上下文投影压缩」整节）。
2) .env.example 中把 STATS_CACHE_OFF 那一行改为 STATS_CACHE=off
   （先 grep 确认代码里真正读的是 STATS_CACHE 还是 STATS_CACHE_OFF，
   以代码为准写文档）。
3) src/config.js：删除 fallbackConfig 的三处引用（27、111、182 行）。
4) 删除 model-fallback.json。
5) 在 src/index.js 的启动流程里加一条检查：
   若 config.ROOT 下仍存在 model-fallback.json，打印
   '[relaygate] 警告：检测到 model-fallback.json，但本版本不实现模型降级，该文件不会被读取。'
   这样老用户升级后能立刻知道自己的配置没用了。
6) backup.js 里对该文件的引用（170、482 行）改为条件处理（文件不存在时跳过）。

【方案 B（实现）】
1) 在选模型/选号逻辑里真正使用 config.fallbackConfig.mappings 与 autoFallback。
2) 在 /ops/config 面板展示「当前降级链」与「命中次数」。
3) 补测试覆盖「主模型不可用时走降级」。

【收尾】
无论哪个方案，都要确认 TOOL_PROTOCOL 是否有行为分支：
grep -rn "toolProtocol" src/
若只有 admin-debug.js 的展示用途、无行为判定，则从 .env.example 移除或
在注释里明确写「仅用于展示，不影响行为」。

最后运行 npm test 确认 288 断言全部通过，exit 0。
```