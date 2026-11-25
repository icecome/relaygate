# RelayGate v3 优化：全量回归验证报告

- 时间：2026-11-25 20:39–20:45 Asia/Shanghai
- 对比基线：[`00-baseline.md`](./00-baseline.md)（commit `8ee43c17f34de339fd2d83d24cac4bd59254a4f7`）

## 1. 优化项完成情况

| 项 | 内容 | 状态 | 专项报告 |
|---|---|---|---|
| D1 | 删除 `TOOL_PROTOCOL` 展示面（docs/config 输出/前端类型），保留 config 兼容读入 | ✅ | [01-D1](./01-D1-tool-protocol.md) |
| D2 | 删除零引用 `growthProgressList` 前端导出 | ✅ | [02-D2](./02-D2-growth-progress-list.md) |
| D3 | 删除类型残留字段（`officialSessions/Requests/Covered`、`verifiedBalance`、`userRegion`） | ✅ | [03-D3](./03-D3-type-residue.md) |
| D4 | 修正 `GrowthPanel.tsx` “每 4 小时”过期注释 | ✅ | 本文件 §3 |
| F1 | 「立即执行一轮」→「立即补跑一次」+ 失败当天不自动重试说明 | ✅ | [05-F1-F2](./05-F1-F2-growth-prompt.md) |
| F2 | 摘要行显示下次自动运行时间（本地 runtime 快照，零上游请求） | ✅ | [05-F1-F2](./05-F1-F2-growth-prompt.md) |
| F3 | 手动补跑更新 `growth-last-run.json`，自动/手动共用 `summarizeRun` | ✅ | [06-F3](./06-F3-manual-last-run.md) |

改动总量：12 个源码/配置/测试文件，+78 / -376 行（其中 331 行删除是工作区既存的历史审计报告删除，非本次优化）。

## 2. 全量回归结果（与基线同口径）

| 指标 | 基线 | 优化后 | 判定 |
|---|---|---|---|
| `npm test` | exit 1，331 passed，1 failed（zcode 本地 JWT，优化前既存） | exit 1，331 passed，**同一个** zcode 失败 | ✅ 无新增失败，失败集合完全一致 |
| `node src/test/growth.test.js` | 16 passed | **17 passed**（+F3 新用例） | ✅ 专项能力增加 |
| `npm --prefix web run lint` | exit 0，0 errors / 1 warning | exit 0，0 errors / **同一** 1 warning | ✅ 无新增告警 |
| `npx biome check src scripts` | exit 0，154 warnings | exit 0，**153 warnings**（清理了 `autoRunGrowth` 未使用导入） | ✅ 告警减少 1 |
| `cd web && npx tsc -b --force` | exit 0 | exit 0 | ✅ |
| `npm run build:web` | exit 0，20 files / 599,396 bytes，entry 207.82 kB / gzip 68.88 kB | exit 0，20 files / **599,774 bytes**，entry 207.82 kB / gzip 68.88 kB | ✅ 体积 +378B（+0.063%），远低于 5% 阈值；文案增加所致 |
| `npm audit --omit=dev` | exit 1（镜像端点不支持，环境限制） | 未重复执行（未改依赖，结论不变） | ✅ 依赖未变 |

## 3. 关键行为边界复核（grep + 代码走查）

| 边界 | 结果 |
|---|---|
| `grep toolProtocol` | 仅剩 `src/config.js:251,368` 兼容读入；展示面（docs/admin 输出/前端类型）清零 |
| `grep growthProgressList` | 前端零残留；后端 `/progress-list` 与 W-07 契约测试保留 |
| 5 个类型残留字段 | `web/src` 零残留；后端多余字段忽略 |
| “每 4 小时一轮” | 已替换为“每天墙钟一次，默认 08:00”；第 112 行 `setInterval` 是手动任务进度轮询，非旧成长定时 |
| 手动补跑执行路径 | 仍为 `runAuto → growthAuto → startAuto → runAccount`（未改）；仅新增成功后写 last-run |
| `scheduleCatchup` 判据 | 仍读 `daily-runs.json`（`dailyRunState`），与新增写入的 `growth-last-run.json` 相互独立，测试 `checkin-scheduling.test.js` 通过 |
| 收起态零上游请求 | F2 新增的 `getRuntime` 是本机 admin 快照读取，非上游请求；原有 `lastRun` 也是本地文件读 |

## 4. 暂停条件检查

| 条件 | 是否触发 |
|---|---|
| 新增测试失败（除基线 zcode 失败外） | ❌ 未触发 |
| TypeScript / lint / build 从通过变失败 | ❌ 未触发 |
| 构建产物体积增长 > 5% | ❌ 未触发（+0.063%） |
| 行为偏离 v3 验收标准 | ❌ 未触发 |

## 5. 结论

v3 报告中明确的 7 个优化项（D1–D4、F1–F3）已全部按原技术方案与优先级落地并逐项验证；全量回归各项指标与基线一致或改善（growth 用例 +1、biome warning -1），无新增功能异常、无性能退化、无范围外改动。

**唯一需要在交付说明中标注的事实**：`npm test` 的 zcode 本地凭据用例失败是优化前既存状态，与本次改动的代码路径无交集，基线报告已完整记录。按用户要求"若发现未达预期或新问题立即暂停"——本次未发现新问题，执行完成；该既存失败不在本次优化范围内。

## 6. 验证产物索引

- `00-baseline.md` — 基线验证报告
- `01-D1-tool-protocol.md` ~ `06-F3-manual-last-run.md` — 各优化项专项验证
- 本文件 — 全量回归与对比
