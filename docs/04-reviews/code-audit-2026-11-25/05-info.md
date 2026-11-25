## 5. 提示级问题（N-01 ~ N-05）

提示级为"代码风格与工程实践建议"，不影响安全与正确性。

---

### N-01 `Math.random()` 用于生成 ID（非安全场景）

| 项 | 内容 |
|----|------|
| **文件** | `src/lib/request-context.js:34`、`src/model-router/dispatch.js:548`、`src/routes/openai.js:526`、`src/routes/anthropic.js:57,176,242`、`src/routes/responses.js:107`、`src/transform/sse.js:168,289`、`src/jobs/scheduler.js:196,444`、`src/upstream/errors.js:267` |
| **等级** | ⚪ 提示 |

这些用途均为**响应 ID / 抖动延时 / turnId**，不参与鉴权或幂等判定的安全边界。**不构成漏洞**。但项目内已有明确的"安全随机"惯例（`credentials/store.js:17` 注释"加密随机，避免 Math.random 可预测"），风格上宜统一。建议：若将来这些 ID 需要参与去重/幂等键，必须换成 `crypto.randomUUID()`；当前可加一行注释声明"仅用于可读性标识，非安全用途"。

---

### N-02 `routes/anthropic.js` 等直接拼接 SSE 帧，未统一走 helper

| 项 | 内容 |
|----|------|
| **文件** | `src/routes/anthropic.js:57`、`src/routes/responses.js:107`（`sseWrite` 已封装，良好）；`src/model-router/dispatch.js:548` |
| **等级** | ⚪ 提示 |

SSE 帧构造在各路由有 3 种写法。`lib/sse-lines.js` 已提供 `createLineFeeder` 处理**入向**，但**出向**帧构造未收敛。`routes/responses.js:55-57` 的 `sseWrite(res,event,data)` 是可复用范式，建议提取到 `lib/` 供 `anthropic.js` 与 `model-router/dispatch.js` 共用，避免 `event:`/`data:` 换行转义处理不一致（当前 `JSON.stringify` 已正确处理，无实际缺陷）。

---

### N-03 `config.reload()` 与初始加载字段重复 40+ 行

| 项 | 内容 |
|----|------|
| **文件** | `src/config.js:161-328`（初始）、`:335-388`（reload） |
| **等级** | ⚪ 提示 |

`reload()` 逐字段重复初始加载的 `parseInt(process.env.X || '默认')` 逻辑。新增配置项时极易只改一处——`maxBodyBytes` 的注释（`:379-380`）已经记录了这种"热更只影响展示值"的口径分裂。建议改为用一张 `HOT_RELOADABLE = { poolStrategy: (v)=>..., ratePaceMs: Number, ... }` 描述表，初始加载与 reload 共用同一遍历（`makeResolveModelOptions` 的抽取已是这个思路，可推广）。

---

### N-04 前端 `admin.ts` 单文件 876 行承载全部管理 API

| 项 | 内容 |
|----|------|
| **文件** | `web/src/shared/api/admin.ts` |
| **等级** | ⚪ 提示 |

按资源域拆分为 `admin/keys.ts`、`admin/accounts.ts`、`admin/jobs.ts` 等，可显著降低改动冲突。当前 `features/accounts`、`features/ops` 均从此单文件导入，模块边界不清晰。

---

### N-05 未发现 `.editorconfig` / 未在 CI 固化 lint

| 项 | 内容 |
|----|------|
| **文件** | 仓库根 |
| **等级** | ⚪ 提示 |

`package.json:27` 有 `lint` 脚本（`biome check src scripts` + 前端 eslint），`check` 脚本（`:42`）把 `npm test && npm run lint` 串起来，但仓库**无任何 CI 配置**（已核验：`.github/`、`.gitlab-ci.yml`、`azure-pipelines.yml` 均不存在），也**无 `.editorconfig`**。建议引入最小 CI（哪怕只是 pre-push hook），固化 `npm run check` + `npm audit --audit-level=high`（后者可直接拦住 H-03 类回归）。

---
