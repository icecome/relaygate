# F1/F2 专项验证：成长面板补跑语义与定时提示

## 改动

- `web/src/features/accounts/GrowthPanel.tsx`：
  - 引入 `getRuntime`，读取本机 `/v1/admin/runtime` 的 `scheduler.nextGrowthAt`（纯本地快照，零上游请求）。
  - 摘要行在“上次运行”后展示 `· 下次自动 HH:mm`。
  - 按钮文案「立即执行一轮」→「立即补跑一次」，并加 title 说明“自动任务失败当天不会自动重试；点此立即补跑一轮（会写上游）”。
  - Panel description、空态 hint、底部 Note 统一为“失败当天不自动重试，可手动补跑”的语义。

## 验证

| 项目 | 结果 |
|---|---|
| `grep` 文案检查 | 无“立即执行一轮”残留；新文案与 `nextGrowthAt` 展示均在位 |
| `cd web && npx tsc -b --force` | exit 0 |
| `npm --prefix web run lint` | exit 0，0 errors，1 warning（基线同项） |

## 行为边界

- 新增的 `getRuntime` 只读取本机 admin runtime 快照，不打上游，不改变收起态“零上游请求”的性质。
- 手动按钮仍调用原 `runAuto()` → `growthAuto()`，执行逻辑未变。

## 结论

F1/F2 符合 v3 验收标准：用户能明确看到自动任务时间与失败补跑语义，未改执行逻辑。
