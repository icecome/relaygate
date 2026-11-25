# RelayGate v3 优化执行：基线验证报告

- 时间：2026-11-25 20:19–20:23 Asia/Shanghai
- 基线 commit：`8ee43c17f34de339fd2d83d24cac4bd59254a4f7`
- Node / npm：`v25.7.0` / `11.10.1`
- package version：`3.1.0`
- 工作树：已有未跟踪的 v1/v2/v3 审查报告，以及一个被删除的历史审计报告（优化前既存状态）

## 1. 基线命令与结果

| 项目 | 命令 | 结果 | 耗时 | 备注 |
|---|---|---:|---:|---|
| 后端测试 | `npm test` | **exit 1** | 14,335 ms | 331 passed，1 failed：`buildAccountFromLocal 产出 zcode/jwt 账号（本机已安装客户端时）: JWT 必含 user_id/sub`（`src/test/unit.test.js:4567-4576`）。本机存在 ZCode 客户端时读取真实本地凭据，但 JWT 无 `user_id/sub`，属于优化前既存的本地环境相关失败 |
| 失败套件复现 | `node src/test/unit.test.js` | **exit 1** | 10,273 ms | 同样 331 passed，1 failed，稳定复现 |
| 前端 lint | `npm --prefix web run lint` | exit 0 | 4,385 ms | 0 errors，1 warning：`useAsyncData.ts:86` unused eslint-disable |
| 后端 lint | `npx biome check src scripts` | exit 0 | 1,830 ms | 320 files checked，154 warnings（既有） |
| TypeScript | `cd web && npx tsc -b --force` | exit 0 | 3,640 ms | 零错误 |
| 前端构建 | `npm run build:web` | exit 0 | 6,502 ms | 110 modules，产物 20 files / 599,396 bytes；entry `index-Bs9S7Kn_.js` 207.82 kB / gzip 68.88 kB |
| 依赖审计 | `npm audit --omit=dev` | **exit 1** | 1,060 ms | 镜像 registry `npmmirror.com` 不支持 advisories bulk endpoint，属环境限制，非项目漏洞结论 |
| 源码规模 | `find` + `wc -l` | — | — | `src/` 非测试 JS 44,251 行；`web/src` TS/TSX 25,109 行 |

## 2. 基线功能状态

- 核心转发、账号池、成长自动化、配置面板、备份/通知等模块的测试除上述 zcode 本地凭据用例外全部通过。
- 前端 TypeScript 与构建通过，说明当前工作树可作为优化基线。
- `npm test` 的 zcode 本地凭据失败与 v3 优化范围（配置展示、`growthProgressList` 导出、类型字段、成长面板文案/提示/last-run）无代码路径交集：失败发生在 `src/zcode/local.js` 的本地 JWT 解析，v3 不触及该文件。

## 3. 验证口径

后续每项优化与最终回归均沿用同一组命令：

1. `npm test`（记录 passed/failed 与失败项列表；允许的集合仅含基线 zcode 本地凭据失败）
2. `npm --prefix web run lint`
3. `npx biome check src scripts`
4. `cd web && npx tsc -b --force`
5. `npm run build:web`
6. 针对性 grep / 专项测试（按优化项定义）

## 4. 暂停条件

若任一验证出现以下任一情况，立即暂停：

- 新增测试失败（除基线 zcode 本地凭据失败外）
- TypeScript / lint / build 从通过变为失败
- 构建产物体积异常增长超过 5%
- 行为偏离 v3 报告明确的验收标准（例如手动补跑不再走同一 `runAccount`）
