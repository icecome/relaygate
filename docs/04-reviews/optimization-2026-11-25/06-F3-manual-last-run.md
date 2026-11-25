# F3 专项验证：手动补跑更新 last-run

## 改动

- `src/jobs/growth-auto.js`：
  - 提取 `summarizeRun(results, total)`，把原先 `autoRunGrowth()` 内联的摘要构造收敛为唯一实现（字段口径完全不变：total/ranAt/okCount/failCount/actions/results）。
  - `autoRunGrowth()` 改为调用 `summarizeRun()`。
  - 导出 `saveLastRun` 与 `summarizeRun`。
- `src/jobs/growth-progress.js`：
  - `startAuto()` 在任务完成后调用 `saveLastRun(summarizeRun(task.results, targets.length))`，使手动补跑也刷新面板摘要。
  - 顺带移除既有未使用的 `autoRunGrowth` 导入（同文件、零行为影响）。
- `src/test/growth.test.js`：新增专项用例，验证两个导出存在、`startAuto` 源码引用了它们、摘要字段口径（actions 只收 ok 且非 skip）、`saveLastRun` 落盘 `growth-last-run.json` 且字段一致。

## 验证

| 项目 | 结果 |
|---|---|
| `node src/test/growth.test.js` | exit 0，17 passed（基线 16 passed → +1 新用例） |
| `npx biome check src/jobs/growth-auto.js src/jobs/growth-progress.js src/test/growth.test.js` | exit 0，1 warning（`readDisk` 既有未使用，非本项引入） |

## 行为边界

- 手动补跑仍复用同一个 `runAccount()`（`growth-progress.js:runAccount` 调用未改）。
- `saveLastRun` 使用原子写（`writeJsonAtomic`），与自动路径同一函数。
- `scheduleCatchup` 判据读的是 `dailyRunState`（`daily-runs.json`），与本项写入的 `growth-last-run.json` 相互独立；本项不触碰 catchup 判据。
- 409 并发锁（`running` 标志）未改。

## 结论

F3 符合 v3 验收标准：手动补跑后摘要行即时更新，自动/手动摘要口径统一，无新增功能异常。
