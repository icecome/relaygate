# D1 专项验证：删除 TOOL_PROTOCOL 展示面

## 改动

- `.env.example`：删除 `TOOL_PROTOCOL` 注释块与示例行。
- `src/routes/admin-debug.js`：从 `/v1/admin/config` 输出删除 `toolProtocol`。
- `web/src/shared/api/admin.ts`：从 `RuntimeConfig` 删除 `toolProtocol: string`。
- 保留 `src/config.js` 对 `TOOL_PROTOCOL` 的读入（`config.js:251,368`）以兼容旧 env，不产生行为分支。

## 验证

| 项目 | 结果 |
|---|---|
| `grep -rn "toolProtocol\|TOOL_PROTOCOL" .env.example src web/src` | 仅剩 `src/config.js:251,368` 两处兼容读入，展示面清零 |
| `cd web && npx tsc -b --force` | exit 0 |
| `npm --prefix web run lint` | exit 0，0 errors，1 warning（与基线相同：`useAsyncData.ts:86` unused eslint-disable） |

## 结论

D1 符合 v3 验收标准：无行为分支变化，三协议工具调用仍由上游响应归一化决定；展示面与文档入口已移除。
