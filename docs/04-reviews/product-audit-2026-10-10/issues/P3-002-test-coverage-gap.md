# P3-002 — 三个转发路由零测试 + 前端零测试 + 后端无 linter

| 字段 | 值 |
|---|---|
| **Priority** | P3（升级为 P1 的条件：在动转发面代码之前） |
| **Category** | 测试 / 可靠性 |
| **Labels** | `testing`, `p3`, `ci`, `backend`, `frontend` |
| **Difficulty** | 中-高（分阶段，2-3 天） |
| **Risk** | 低（纯新增） |
| **来源** | product-professor full audit 2026-10-10 |

---

## Evidence

### 已有的（真实资产，值得记录）

```
node src/test/unit.test.js    → 236 passed, exit 0
node src/test/growth.test.js  →  11 passed, exit 0
node src/test/security.test.js→  41 passed, exit 0
                                ─────────────
                                288 断言全绿
```

44 个测试分组覆盖：transform / upstream-client.buildBody / errors / pool / credits / oauth / stats / retention / atomic-write / backup / rotate / scheduler / model-router（含 `dispatchTraeStream` 真流式）/ variant / zcode 全套。

**并且有一条"依赖方向不变量"的静态扫描测试**（[unit.test.js](../../../../src/test/unit.test.js) 约 2062-2092 行）—— 这是超出同类个人项目的工程实践。

### 缺口（真正的问题）

| # | 缺口 | 后果 |
|---|---|---|
| 1 | **`routes/openai.js`、`anthropic.js`、`responses.js` 三个文件在全部测试中一个 `require` 都没有** | 产品的对外契约完全无自动化保护。**P2-003 的"错误当内容"缺陷正因此漏出** |
| 2 | **无任何 HTTP 层测试**（`package.json` 无 devDependencies，无 supertest） | 中间件链（auth → rateLimit → ACL）只在单元层测，端到端的鉴权/限流组合未验证 |
| 3 | **三协议的完整流序列未测** | 只测了 `exportOpenAI().text()` / `exportAnthropic().toolCall()` 的**单块输出**；多块、工具调用拼接、截断、流内错误全未覆盖 |
| 4 | **流中途失败整条路径未测** | `dispatchTraeStream` 只测了"未写头"场景 |
| 5 | **`store.js` 并发写零测试** | **P0-001 正因此漏出** |
| 6 | **`db.js` schema 迁移、`rate-limit.js`、`health.js` rpm 滑窗零测试** | — |
| 7 | **前端零测试**（`web/package.json` 无 vitest/jest，无 `.test.tsx`） | 12107 行前端代码无自动化保护 |
| 8 | **`src/` 108 个文件无 linter / formatter / TS 检查** | [package.json:9](../../../../package.json) 的 `"lint": "npm --prefix web run lint"` **只覆盖前端**。`store.update` 传错字段名、`pool.record` 传错 kind 字符串这类错误编译期/lint 期均不捕获 |

### ⚠️ CI 陷阱

`unit.test.js` 失败时**仍会打印 `N passed`**（`FAIL` 走 stderr）。**只看 stdout 会把失败读成成功。**

当前 `npm test` 用 `&&` 串联，这点是对的。但**仓库里没有 CI**（`.github/workflows` 不存在），所以这个陷阱目前无人踩也没人防。

---

## Why it matters

288 个绿灯容易被误读为"系统可靠"。实际覆盖的是**数据转换层**，而产品的**对外契约层**（三个协议路由）与**可靠性关键路径**（并发写、优雅停机）是空的。

这解释了一个看似矛盾的现象：项目有 288 个断言，却在本次审计中查出 2 个 P0 与 8 个 P1。

**测试的广度不等于测试的对齐度。** 覆盖了容易测的（纯函数），漏掉了难测但重要的（路由 + 并发）。

---

## Expected behavior

1. 三个协议路由有集成测试（mock 上游，不消耗额度）。
2. 有 HTTP 层测试（中间件链）。
3. 并发写有测试（配合 P0-001）。
4. 前端关键组件有测试（至少：hooks、api 内核）。
5. `src/` 有 linter（ESLint 或 Biome）。
6. 有 CI 且**严格检查 exit code**。

---

## Acceptance criteria

**阶段 1（优先级最高，2 小时内可完成）：**

1. 新建 `.github/workflows/ci.yml`，运行 `npm test` + `npm --prefix web ci && npm --prefix web run lint && npm --prefix web run build` + `npm audit --audit-level=high`。
2. CI **显式检查 exit code**（`npm test` 的 `&&` 链已保证，但要在 workflow 里确认没有 `|| true` 之类的吞错写法）。
3. `src/` 接入 linter（推荐 Biome，配置成本最低；或 ESLint 复用 web 的配置）。

**阶段 2（协议层测试，与 P2-004 重构配套）：**

4. 新建 `src/test/protocol.test.js`：每协议 3 个用例（正常流 / 中途错误 / 截断），mock 上游。
5. 覆盖"流内错误回灌账号池"路径（验证 `anthropic.js` 的时序修复，见 P2-003）。

**阶段 3（前端测试）：**

6. `web/` 接入 vitest，至少覆盖：
   - `shared/api/http.ts`（超时、取消、去重、401 分流）
   - `shared/hooks/useAsyncData.ts`（取消、错误暴露）
   - `shared/lib/format.ts`（纯函数，最容易）
   - `features/accounts/accountPacks.tsx`（FEFO/urgency 派生逻辑，纯函数）

**阶段 4（并发与 HTTP 层）：**

7. `src/test/store-concurrency.test.js`（配合 P0-001）。
8. 引入 supertest 或等效，覆盖中间件链的鉴权/限流组合。

---

## Implementation notes

### 为什么先做 CI 而不是先补测试

CI 是**防止已有 288 断言退化**的机制。当前没有 CI，意味着任何一次改动都可能悄悄打破它们（尤其考虑到 `N passed` 的假阳性陷阱）。

成本 30 分钟，收益是"从今往后的所有改动都有守门"。

### 为什么协议测试要排在 P2-004 之前

P2-004（协议适配层重构）风险高的根本原因是**没有守门**。先建测试再重构，是这次重构唯一能安全进行的方式。

### `src/` linter 的选择

| 选项 | 成本 | 收益 |
|---|---|---|
| Biome | 极低（单依赖、零配置即可跑） | 捕获未定义变量、未使用导入、明显错误 |
| ESLint + typescript-eslint | 中（需配置） | 更强，但与 `web/` 配置需协调 |
| `node --check` 遍历 | 零 | 只查语法错误 |

推荐 Biome：本项目后端是纯 JS（无 TS），Biome 的零配置模式能立刻抓到"传错字段名"这类常见错误之外的机械问题。

---

## 可直接执行的修复提示词

```
为 RelayGate 建立测试与静态检查的守门机制。分四个阶段，按顺序执行。

背景（已核实）：
- 现有 288 断言全绿（unit 236 + growth 11 + security 41），广度高（含依赖方向静态扫描测试）
- 但 routes/openai.js、anthropic.js、responses.js 三个文件在全部测试中一个 require 都没有
- 无 HTTP 层测试（package.json 无 devDependencies，无 supertest）
- store.js 并发写零测试、db.js schema 迁移零测试、rate-limit.js 零测试
- 前端零测试（web/package.json 无 vitest/jest）
- src/ 108 个文件无任何 linter（package.json:9 的 lint 只覆盖 web/）
- 无 CI（.github/workflows 不存在）
- ⚠️ 陷阱：unit.test.js 失败时 stdout 仍会打印 "N passed"（FAIL 走 stderr），
  所以 CI 必须严格检查 exit code

—— 阶段 1：CI + 后端 linter（2 小时，最高优先）——

1) 新建 .github/workflows/ci.yml：
   name: ci
   on: [push, pull_request]
   jobs:
     test:
       runs-on: windows-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: '22' }
         - run: npm ci
         - run: npm test                    # 必须检查 exit code，不要加 || true
         - run: npm --prefix web ci
         - run: npm --prefix web run lint
         - run: npm --prefix web run build
         - run: npm audit --audit-level=high
   注意：windows-latest 是必要的（轮换功能依赖 Windows 会话模型与 schtasks）。

2) src/ 接入 linter（推荐 Biome，零配置即可跑）：
   - 根 package.json 加 devDependency @biomejs/biome
   - biome.json 只开 recommended 规则，先不启用格式化（避免大规模 diff）
   - package.json 的 lint 脚本改为同时跑 web 与 src：
     "lint": "npm --prefix web run lint && npx biome check src"
   - 首次运行若报大量既有问题，分两类处理：
     a) 真实问题（未定义变量、明显错误）→ 修
     b) 风格问题 → 通过 biome.json 的 overrides 或 ignore 暂时压住，标注 TODO

—— 阶段 2：协议层测试（与 P2-004 重构配套，必须先于重构完成）——

3) 新建 src/test/protocol.test.js：
   - mock upstream/client.js 的 llmUtilsChat（用与 unit.test.js 相同的 WORKSPACE_DIR 隔离模式）
   - 每协议 3 个用例：正常流 / 中途错误 / 截断
   - 断言点：
     OpenAI：不出现含 '[Error' 的 delta.content；以 [DONE] 收尾；截断时 finish_reason='length'
     Anthropic：错误用 {type:'error'} 事件；stop_reason 正确
     Responses：截断时不写 status:'completed'
   - 额外用例：流内限流时 pool.record 收到的 accountId 非 null（验证 anthropic.js 时序修复）

—— 阶段 3：前端测试 ——

4) web/ 接入 vitest（+ @testing-library/react 若需要组件测试）：
   优先覆盖（按性价比排序）：
   - web/src/shared/lib/format.ts（纯函数，最容易，且是口径逻辑的集中地）
   - web/src/features/accounts/accountPacks.tsx 的 packsOf / urgencyOf / worstExpiry
     （FEFO 与临期判定，纯函数，且是业务关键逻辑）
   - web/src/shared/api/http.ts（超时/取消/去重/401 分流——需要 mock fetch）
   - web/src/shared/hooks/useAsyncData.ts（取消、错误暴露）
   在 web/package.json 加 "test": "vitest run"，并在 CI 里调用。

—— 阶段 4：并发与 HTTP 层 ——

5) src/test/store-concurrency.test.js（与 P0-001 配套，见该 issue）
6) 引入 supertest，覆盖中间件链：
   - 无密钥访问 /v1/admin/* → 401
   - 访问密钥访问 /v1/admin/* → 401（类型不匹配）
   - 登录密钥访问 /v1/chat/completions → 401
   - 超过 rpm 限制 → 429
   - 平台密钥 + 受限 resources → 403（M-S5 的 HTTP 层验证）

每完成一个阶段运行一次全量 npm test 确认无回归。
```