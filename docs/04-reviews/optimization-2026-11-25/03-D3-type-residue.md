# D3 专项验证：删除类型残留字段

## 改动

- `web/src/shared/api/stats.ts`：删除 `DailyStat.officialSessions`、`officialRequests`、`officialCovered` 及其专属注释。
- `web/src/shared/api/workbuddy.ts`：删除 `WbImportResult.verifiedBalance`。
- `web/src/shared/api/types.ts`：删除 `Account.userRegion` 及其注释块。

## 验证

| 项目 | 结果 |
|---|---|
| `grep -rn "officialSessions\|officialRequests\|officialCovered\|verifiedBalance\|userRegion" web/src` | 无残留 |
| `cd web && npx tsc -b --force` | exit 0 |
| `npm --prefix web run lint` | exit 0，0 errors，1 warning（基线同项） |

## 结论

D3 符合 v3 验收标准：仅删除当前前端零读取的类型残留；后端响应中若仍带同名字段会被 TypeScript 结构类型忽略，不影响渲染或 API 调用行为。
