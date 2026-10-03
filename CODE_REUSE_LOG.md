# CODE_REUSE_LOG

> 代码复用阶梯（Code Reuse Ladder）评估记录。
> 项目：RelayGate（`my-trae-api`）| 评估日期：2026-10-03 | 评估轮次：首轮
> 关联报告：`docs/review/01-总体审查报告.md`（问题 ID 与本文档交叉引用）

## 评估口径

- 每条结论必须绑定证据：**候选文件已读** + **引用点数（grep 命中）** + **测试覆盖情况**。
- 测试门槛：候选复用目标无测试或覆盖率不足时，结论降级并显式标注风险。
- 迁移成本：S < 1 小时；M < 1 人日；L > 1 人日。
- 引用点数为**全库 `src/**/*.js` 命中数（含声明处）**，由脚本逐文件统计。

## 全库复用基线（先确认哪些已有资产可用）

| 已有资产 | 位置 | 引用点 | 测试提及 | 结论 |
|---------|------|--------|---------|------|
| `variantOf` / `hostFor` / `regionOf` / `validRegion` | `src/platform/variant.js`（208 行） | 38 / 16 / 20 / 16 | 15 / 9 / 4 / 3 | 平台差异单一事实源，**已充分复用且被测试守门** |
| `writeJsonAtomic` / `writeFileAtomic` | `src/lib/atomic-write.js`（69 行） | 37 / 24 | 2 / 9 | 17 个文件已复用，**原子写入事实标准** |
| `stateFile` / `resolveStateFileForRead` | `src/lib/paths.js`（66 行） | 34 / 22 | 4 / 0 | 13 个文件已复用；`resolveStateFileForRead` 无直接测试 |
| `appendTaskLog` | `src/jobs/task-log.js`（89 行） | 19 | 2 | 已复用；`runKeepalive` / `runGrowthAuto` 未接入（见 M-E2） |
| `classifyError` | `src/upstream/errors.js`（136 行） | 18 | 8 | 错误分类单一入口，**已充分复用** |
| `canUseModel` | `src/middleware/model-access.js`（125 行） | 16 | 6 | 已复用，但 2 处调用漏传 `authKey`（见 M-S4） |
| `createStreamHandler` | `src/transform/sse.js`（323 行） | 19 | 8 | SSE 解析单一入口，**已充分复用** |
| `summarizeExpiry` / `roundCredits` | `src/credentials/credits.js`（55 行） | 22 / 21 | 10 / 12 | 权益包纯计算单一入口，**已充分复用** |
| `planSpread` / `runPlanned` / `localDateKey` / `sleep` | `src/lib/util.js`（146 行） | 11 / 11 / 13 / 35 | 7 / 3 / 4 / 0 | 确定性错峰与延时统一入口；`sleep` 有 1 处本地副本 |
| `getEffective`（各设置模块） | 5 个设置模块 | 49 | 4 | 语义统一但**实现各自一份**（见下 REUSE #4） |

**基线结论**：项目已具备较完善的复用基础设施（`lib/` + `platform/` + `transform/` 三处收敛点），146 个测试为多数收敛点提供了守门。本轮的复用机会集中在**尚未收敛的 5 组重复实现**。

---

## REUSE #1 — `round2` / `round4` 四舍五入助手

```
[round2 / round4 四舍五入助手]
位置: src/log/stats.js:36,40（另有 5 处副本，见证据）

当前实现: Number.isFinite 守卫 + Math.round(n*100)/100（round2）；*10000（round4）

阶梯结论: Step 2 - REUSE_EXISTING
（类型：REUSE_EXISTING；同库内已有等价实现且覆盖面更广）

复用证据:
  - 候选 1：src/credentials/credits.js:14 `roundCredits(n)`
      全库引用点 21（3 个文件：credentials/pool.js、upstream/balance.js、自身）
      测试提及 12（unit.test.js 有 'roundCredits 消除浮点噪声' 两个用例）
  - 候选 2（现被复制的来源）：src/log/stats.js:36,40
      全库 round2 引用 29（5 文件）、round4 引用 12（3 文件）
      测试提及 0（unit.test.js 与 growth.test.js 均未 require ../log/stats）

证据核验:
  - 已读 src/log/stats.js:36-42 与 src/credentials/credits.js:14-17，两者语义一致
  - 逐文件扫描确认 round2 定义 6 处：
      src/jobs/credit-alerts.js:47
      src/log/client-logs.js:40
      src/log/stats-cache.js:35
      src/log/stats.js:36
      src/routes/credentials.js:84
      src/workbuddy/billing-usage.js:30
    round4 定义 3 处：client-logs.js:41、stats-cache.js:36、stats.js:40
  - 已确认 src/test/ 下无任何文件 require('../log/stats') 或 require('../log/stats-cache')（正则命中 NO）

迁移成本: S（9 处替换为同一 import；纯函数无副作用）

破坏性变更: 否（返回值为 number，语义完全一致）

测试覆盖: 候选 roundCredits 有 12 处测试提及（含两个专门用例）；
          但被替换的 log/stats.js 侧当前 0 覆盖 → 替换后需为 stats 聚合补用例

建议:
  1. 在 src/lib/ 下新建 round.js，导出 round2 / round4（保留两个精度，因 stats 侧确需 4 位）
     并让 credentials/credits.js 的 roundCredits 委托给它，消除「同语义两个名字」
  2. 9 处副本改为 import：jobs/credit-alerts.js:47、log/client-logs.js:40,41、
     log/stats-cache.js:35,36、log/stats.js:36,40、routes/credentials.js:84、
     workbuddy/billing-usage.js:30
  3. 连带改动清单：上述 9 处；无外部调用方受影响（均为模块内私有）
  4. 补测试：为 log/stats.js 的 dailyStats/modelStats/accountStats 加用例（当前 0 覆盖）

优先级: LOW（正确性无风险，纯维护面收敛；9 处替换约 30 分钟）
```

---

## REUSE #2 — `sleep` 延时

```
[sleep 延时]
位置: src/lib/util.js:9（另有 1 处本地副本）

当前实现: new Promise(r => setTimeout(r, ms))

阶梯结论: Step 2 - REUSE_EXISTING

复用证据:
  - 候选：src/lib/util.js:9 `sleep(ms)`
      全库引用点 35（8 个文件）
      测试提及 0（无专门用例，但 planSpread/runPlanned 的用例间接覆盖其行为）
  - 副本：src/jobs/rotate-accounts.js:228
      `function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }`
      该文件其余位置**未**从 lib/util 引入 sleep

证据核验:
  - 已读 src/jobs/rotate-accounts.js:228 与 src/lib/util.js:9，实现逐字等价
  - 已 grep 确认 rotate-accounts.js 的 require 列表（第 8-14 行）不含 lib/util
  - 全库 `function sleep(` 命中 2 处，即上述两处

迁移成本: S（1 行替换 + 1 行 import）

破坏性变更: 否

测试覆盖: lib/util.js 的 planSpread / runPlanned / deterministicOffsetMs 有 7+3+3 处测试提及；
          sleep 本身无直接用例（属可接受的薄封装）

建议:
  1. rotate-accounts.js 删除本地 sleep，改从 '../lib/util' 引入
  2. 连带改动清单：仅 rotate-accounts.js（sleep 在该文件内被多处调用，import 后无需改调用点）
  3. 该文件同批可一并处理 M-R2（CIM 引号修正），两者同在 rotate-accounts.js 内

优先级: LOW
```

---

## REUSE #3 — SSE 残行缓冲循环

```
[SSE 行缓冲（累加 chunk → 按 \n 切分 → pop() 残行）]
位置: src/routes/openai.js:389-395（另有 3 处副本）

当前实现: buffer += chunk; lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (line of lines) handler.feedLine(line)

阶梯结论: Step 2 - PARTIAL_REUSE
（类型：PARTIAL_REUSE；已有 consumeStream 封装了「消费流」，但未封装「按行切分」）

复用证据:
  - 候选：src/upstream/client.js:379 `consumeStream(body, onText, debugCtx)`
      全库引用点 9（4 个文件：routes/openai.js、routes/anthropic.js、routes/responses.js、
      workbuddy/chat.js 的调用方）
      测试提及 0（无直接用例）
      职责：只做「读流 → 回调 chunk」，不含行切分
  - 副本 4 处（已逐处读原文确认结构一致）：
      src/model-router/dispatch.js:320,322
      src/routes/anthropic.js:142,144
      src/routes/openai.js:390,392
      src/workbuddy/chat.js:64,66
  - 反例（第 5 处，缺缓冲）：src/routes/responses.js:130-134
      直接 `text.split('\n')` 逐块喂入，无残行保留 → 上游事件被 chunk 边界切开时整行丢失

证据核验:
  - 已读 4 处副本原文，均为同一模式；已读 responses.js:130-134 确认缺缓冲
  - createStreamHandler（transform/sse.js）导出 feedLine/ingest/flushToolAccum，
    测试提及 8（unit.test.js 有 '提取裸工具 JSON (ingest)'、'跨 chunk 拆分裸工具 JSON (feedLine)' 等）
  - 已确认 consumeStream 自身无测试提及

迁移成本: S~M（抽 1 个 8 行工厂 + 5 处替换；responses.js 属缺陷修复而非纯替换）

破坏性变更: 否（对 4 处现有调用是等价替换；对 responses.js 是修复）

测试覆盖: createStreamHandler 有 8 处测试提及（覆盖跨 chunk 场景）；
          新建的行缓冲工厂可直接复用既有跨 chunk 用例的构造方式

建议:
  1. 在 src/transform/sse.js 旁新建 src/transform/line-buffer.js：
       createLineBuffer(onLine) → { push(chunk) }，内部维护残行
     放在 transform/ 下与 createStreamHandler 同层，因两者是同一领域的两个纯函数
  2. 5 处替换：
       model-router/dispatch.js:317-357（WorkBuddy 直通循环，同时保留其 usage 裁剪逻辑）
       routes/anthropic.js:140-146
       routes/openai.js:388-395
       workbuddy/chat.js:60-93（chatAggregate 内）
       routes/responses.js:130-134 ← 顺带修掉 m-07 的残行缺陷
  3. 连带改动清单：上述 5 处；createStreamHandler 接口不变，无其他调用方受影响
  4. 补测试：为 line-buffer 加「chunk 边界切在 JSON 中间」用例，参照 unit.test.js 既有跨 chunk 用例

优先级: MEDIUM（其中 responses.js 的缺失属可靠性缺陷 m-07，建议随 P2 重构一并处理）
```

---

## REUSE #4 — JSON 设置模块（getEffective / save / readStored）

```
[JSON 设置模块工厂]
位置: src/jobs/scheduler-settings.js（另有 4 处同构模块）

当前实现: 各自实现 readStored() + getEffective()（文件 > env > 默认）+ save()（白名单 + clamp）
          + writeJsonAtomic()

阶梯结论: Step 2 - PARTIAL_REUSE
（类型：PARTIAL_REUSE；抽取公共骨架，保留各模块的字段表与 clamp 区间）

复用证据（5 个同构模块，逐个已读）:
  | 模块 | 行数 | getEffective | save | readStored | writeJsonAtomic 调用 | 字段表 |
  |------|------|-------------|------|-----------|---------------------|--------|
  | src/jobs/scheduler-settings.js | 88 | 1 | 1 | 1 | 2 | SPECS（14 字段，含 min/max/env） |
  | src/jobs/rotate-settings.js | 90 | 1 | 1 | 1 | 2 | 内联 clampInt 逐字段 |
  | src/notify/settings.js | 144 | 1 | 1 | 1 | 4 | FIELDS（9 字符串）+ EVENTS |
  | src/jobs/balance-refresh.js | 210 | 1 | 1 | 1 | 2 | DEFAULTS + clampMinutes |
  | src/jobs/backup.js | 384 | 1 | 1 | 1 | 3 | DEFAULTS + clampKeep/clampHours |
  全库 `getEffective` 引用点 49（11 个文件）——说明这 5 个模块的对外接口已被广泛依赖

证据核验:
  - 已逐个读 5 个模块全文，确认骨架同构（差异仅字段表与 clamp 区间）
  - 已确认各模块均导出 FILE / SPECS 或 FIELDS（外部有引用），故不能整体替换
  - 差异点已核实：notify/settings.js 无 clamp（字符串字段）；backup.js 的 dir 走 path.resolve；
    rotate-settings.js 用内联 clampInt 而非 SPECS 表

迁移成本: M（5 个模块改造 + 保持各自导出面）

破坏性变更: 否（对外导出与生效语义保持不变）

测试覆盖: getEffective 有 4 处测试提及（scheduler-settings 的文件优先于 env 与越界夹紧用例、
          balance-refresh 的默认关闭与间隔夹紧用例）；其余 3 个模块无专门用例

建议:
  1. 新建 src/lib/settings-store.js：
       createSettingsStore({ file, specs, envMap, transforms }) → { getEffective, save, FILE, readFile }
     specs 采用与 scheduler-settings.js 同形（{ env, default, min, max }），
     对无区间字段（如字符串、路径）用 transform 钩子而非 min/max
  2. 5 个模块改为调用工厂，各自保留：SPECS/FIELDS/EVENTS 常量、FILE 导出、模块特有逻辑
     （notify 的事件增删、backup 的 dir 解析与 backupKey、balance-refresh 的 running 互斥）
  3. 连带改动清单：上述 5 个模块；49 处 getEffective 调用点**无需改动**（签名与语义不变）；
     docs/review/01 中的 m-13 可一并关闭
  4. 补测试：把 scheduler-settings 的既有 2 个用例泛化为对工厂的用例，5 个模块共享

优先级: MEDIUM（维护面收益明确，但需保证 49 个调用点的语义不变，建议单独一次提交）
```

---

## REUSE #5 — `mask` / `maskToken` 敏感值脱敏

```
[mask / maskToken 脱敏]
位置: src/log/traffic.js:23（另有 1 处独立实现）

当前实现:
  - log/traffic.js:23  mask(v)：len<=12 原样；否则 `前6...sha256前8`
  - routes/workbuddy.js:23 maskToken(t)：len<=16 返回 '***'；否则 `前8…后6`

阶梯结论: Step 2 - PARTIAL_REUSE
（类型：PARTIAL_REUSE；抽公共函数 + 保留两种展示口径的参数）

复用证据:
  - src/log/traffic.js:23 `mask` — 全库引用点 8（2 个文件：自身 + sanitize 递归）
      测试提及 3（unit.test.js 有 'sanitize 脱敏 authorization' 用例）
  - src/routes/workbuddy.js:23 `maskToken` — 全库引用点 2（仅自身文件）
      测试提及 0
  - 前端侧另有一处不一致：web/src/pages/Settings.tsx:539-545 的 channelSummary
      对 Telegram chatId / webhook URL 明文展示，而同函数内 serverChan/pushPlus 已做 slice(-4)
      （见 m-19，属同类口径问题，但前端与后端脱敏策略可分开处理）

证据核验:
  - 已读两处实现原文，确认脱敏策略不同（一个含哈希、一个保尾部）
  - 全库 `function (mask|maskToken)` 命中 2 处
  - 已确认 traffic.js 的 mask 被 sanitize 递归调用（35-36 行），改签名需同步 sanitize

迁移成本: S

破坏性变更: 否（日志脱敏结果变化不影响功能；workbuddy 响应脱敏结果变化会改变前端展示，
            但前端仅展示不解析，可接受）

测试覆盖: traffic.js 的 sanitize 有 3 处测试提及（含专门用例）；
          workbuddy.js 的 maskToken 无测试

建议:
  1. 在 src/lib/ 下新建 mask.js，导出 `maskSecret(v, { keepHead, keepTail, hash })`：
       - 日志场景：maskSecret(v, { keepHead: 6, hash: true }) → 保持现有 traffic 行为
       - 响应场景：maskSecret(v, { keepHead: 8, keepTail: 6 }) → 保持现有 workbuddy 行为
  2. 两处改为调用，删除本地实现；traffic.js 的 sanitize 调用点同步更新
  3. 连带改动清单：src/log/traffic.js:23,35-36；src/routes/workbuddy.js:23,43,44,166
  4. 补测试：为 maskSecret 两个参数组合各加 1 个用例（含短值边界）

优先级: LOW（口径统一属维护面收益；若只做一处替换价值有限，建议与 REUSE #1 合并为一次
          「lib 公共工具收敛」提交）
```

---

## 不采纳的复用评估（记录决策依据）

| 候选 | 阶梯结论 | 理由 |
|------|---------|------|
| 用现成库替换 `lib/trae-decrypt.js`（212 行手写 tc 解密） | Step 5 - THIRD_PARTY_SKIP | 该格式是 Trae 客户端私有加密，无公开库；算法依赖 4 个硬编码 salt 常量（见 Q-01），任何第三方库都无法覆盖。**保留自研** |
| 用 `zod` 等替换手写参数校验（各路由的 `Number.isFinite` / `Math.min(Math.max())`） | Step 1 - SKIP | 当前校验点分散但每处仅 1-3 行，引入 schema 库会增加依赖与打包体积；且项目无 `devDependencies`，保持零运行时依赖的取舍合理。**暂不引入** |
| 用 `winston` / `pino` 替换 `log/traffic.js` + `log/crash.js` | Step 5 - REFERENCE_ONLY | 两个日志模块合计 183 行，功能是「脱敏 + 单行 JSON + jsonl 追加」，winston/pino 的能力（多 transport、格式化、级别过滤）当前用不到。**可参考其轮转设计**（对应 m-01 的日志无轮转问题），但不引入依赖 |
| 用 `express-rate-limit` 替换 `middleware/rate-limit.js`（52 行滑窗） | Step 5 - THIRD_PARTY_SKIP | 现实现仅 52 行、语义明确（密钥级 RPM + 429 + Retry-After），且需要按 `req.apiKeyId` 而非 IP 限流，替换需额外配置。**保留自研** |
| 用 `helmet` 替换「无安全响应头」的现状 | Step 5 - USE_THIRD_PARTY_PARTIAL | 这是 M-S3 的修复路径之一。`helmet` 体积小、维护活跃、按中间件启用，可只取 `contentSecurityPolicy` 与 `xContentTypeOptions` 两项而非全量。**建议在修 M-S3 时评估**（也可手写 3 行响应头，视是否接受新增依赖而定） |
| 用 `react-error-boundary` 替换手写 Error Boundary | Step 6 - INLINE_ONE_LINE | Error Boundary 需 `class` + `getDerivedStateFromError`，约 20 行，属 M-R4 的修复。抽成库只省 20 行却新增依赖，**内联实现即可** |
| 用 `date-fns` 替换 `lib/format.tsx` 的格式化函数 | Step 3 - USE_STDLIB | 现有实现基于 `toLocaleString('zh-CN')` 与 `Intl`，属标准库能力，无需第三方。**维持现状** |
| 用 `lodash` 替换 `web/src/lib/` 中的手写工具 | Step 1 - SKIP | 前端 lib 层仅 5 个文件 390 行（`api` / `format` / `nav` / `ops` / `store`），无 lodash 已能覆盖的场景（`format` 用 `Intl`、`store` 用 `useSyncExternalStore`）。**不引入** |
| 前端 `RowMenu.tsx`（103 行，全库未被引用） | Step 1 - SKIP | 阶梯第 1 步：该功能当前无业务需求。**建议直接删除**（对应 n-01），而非「找地方复用」 |
| 后端 `enforceModelAccess`（中间件，全库无调用点） | Step 1 - SKIP | 各路由已改为直接调用 `canUseModel`，中间件形态不再需要。**建议删除**（对应 m-05） |
| 后端 `sweepExpired`（全库无调用点） | Step 1 - SKIP | 与 RowMenu 不同：这里有**真实需求**（`rotateKey` 注释明确依赖它完成旧密钥宽限期失效，见 m-04），属「定义了但未接线」。**应接入而非删除** |

---

## 汇总与建议排期

| 优先级 | 条目 | 迁移成本 | 关联报告问题 |
|--------|------|---------|-------------|
| MEDIUM | REUSE #3 SSE 行缓冲抽取（含修复 m-07） | S~M | m-07、m-12 |
| MEDIUM | REUSE #4 设置模块工厂 | M | m-13 |
| LOW | REUSE #1 round2/round4 收敛（9 处） | S | m-08 |
| LOW | REUSE #2 sleep 收敛（1 处） | S | m-09 |
| LOW | REUSE #5 mask 统一（2 处） | S | m-11 |

**执行建议**：REUSE #1 / #2 / #5 三者均为 S 级且同属「lib 公共工具收敛」，建议合并为一次提交（约 1 小时内完成），先跑 `npm test` 确认 146 个用例仍全绿。REUSE #3 与 #4 各需一次独立提交，理由分别是「含缺陷修复」与「影响 49 个调用点的语义不变性」。

**未采纳但需注意**：`regionOf` / `validRegion` 在 `workbuddy/auth.js:42,46` 有副本（m-10），但**不在本次阶梯评估范围内**——因为 `platform/variant.js` 是项目已确立的「平台差异单一事实源」（其头部注释明确论证了这一决策），此处属**已确立复用路径的未完成迁移**，按 REUSE_EXISTING_DEPRECATE 处理更合适：直接把 workbuddy/auth.js 的两处改为从 variant 引入即可，无需新评估。

**证据声明**：本日志所有引用点数由脚本逐文件统计（含声明处），测试提及数为 `src/test/unit.test.js` + `src/test/growth.test.js` 中的正则命中数。所有候选文件均**已实际读取全文**，未使用未验证的符号。测试覆盖率的绝对值（百分比）未测量——项目未接入覆盖率工具（无 `c8` / `nyc` 依赖），故以「有无专门用例 + 测试提及数」作为代理指标，这是**降级判断**，已在各条目的「测试覆盖」字段显式标注。