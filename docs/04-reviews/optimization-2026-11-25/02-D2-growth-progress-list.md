# D2 专项验证：删除 growthProgressList 前端导出

## 改动

- `web/src/shared/api/growth.ts`：删除零引用的 `growthProgressList` 前端 API 导出。
- 不删除后端 `/v1/workbuddy/growth/progress-list` 端点与 `src/test/wiring.test.js` 的 W-07 契约测试。

## 验证

| 项目 | 结果 |
|---|---|
| `grep -rn "growthProgressList" web/src src` | 无残留 |
| `cd web && npx tsc -b --force` | exit 0 |
| `npm --prefix web run lint` | exit 0，0 errors，1 warning（基线同项） |

## 结论

D2 符合 v3 验收标准：删除的是当前代码可证的前端零引用导出，不影响手动补跑、自动补跑、进度轮询主链路，也不影响后端契约测试。
