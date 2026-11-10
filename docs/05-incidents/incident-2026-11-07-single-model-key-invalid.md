#事故报告：单个后端模型提示「API 密钥失效」，只剩聚合虚拟模型可用

- **日期**：2026-11-07
- **影响面**：所有**平台访问密钥**（`platform=trae` / `platform=workbuddy`）调用**单个物理模型**。
- **表现**：请求返回 HTTP 403、`type=auth_error`、`code=MODEL_ACCESS_DENIED`；客户端把 403 统一显示为
  「API 密钥失效」。聚合虚拟模型（`vm/long-context` 等）一切正常。
- **状态**：已修复（代码 + 数据两侧）。生产进程需重启后生效（见文末「落地步骤」）。

---

## 1. 复现

`node scripts/repro-key-scope.js`（修复前输出）：

```
— key_mu0jgnwhf7dcdd2c  label=bootstrap-trae  platform=trae
  DB scopes   = ["models:read"]
    virtual    vm/long-context    → ALLOW
    traeSingle glm-5.3            → DENY  access denied: scope_missing:models:invoke
    wbSingle   wb/glm-5.3         → DENY  model "wb/glm-5.3" is WorkBuddy-only. …
```

黑盒（对运行中的网关）：

```
=== bootstrap-trae (platform=trae)
   models-list  -> 200          ← 列得出模型
   virtual      -> 200          ← 聚合模型正常
   trae-single  -> 403 {"error":{"message":"access denied: scope_missing:models:invoke",…}}
```

---

## 2. 根因

两个**叠加**根因。它们同时存在时，症状恰好是「只有聚合模型可用」。

### R1 —— scope 迁移把历史密钥写坏（数据侧）

`src/credentials/api-keys.js#ensureModelsReadScope` 的旧实现：

```js
const list = parseJsonArr(row.scopes, []);   // scopes=NULL → []
if (list.includes('models:read')) continue;
const merged = [...list, 'models:read'];      // ['models:read']
```

`scopes` 列是 2026-10-03 引入的；此前列为 NULL 的历史密钥在这里被当成「空列表」，
再补一个 `models:read` 写回 —— 于是「NULL = 走默认值（含 `models:invoke`）」被静默改成
「只有 `models:read`」。

而转发面的判定链（`middleware/model-access.js` → `auth/scope.js#canInvokeModel`）要求
`models:invoke`：单模型调用 → `403 scope_missing:models:invoke`；
虚拟模型分支**不校验 scope** → 聚合模型照常。

> 这正是「客户端显示 API 密钥失效」的由来：403 + `type=auth_error`，
> 客户端把它当成凭据问题，而真实原因是「这把密钥的 scope 列表被迁移脚本写坏了」。

### R2 —— 「WB 独有」判定只看静态名单（代码侧）

`src/middleware/model-access.js#isWorkBuddyOnlyModel` 旧实现只对照
`workbuddy/chat.js` 的静态 `WB_MODELS`。实测（2026-11-07，`llm_utils_chat` 逐个调用）：

| 模型 | Trae 上游实测 | WB 名单 | 旧判定 | 真实 |
|---|---|---|---|---|
| `glm-5.3` | ✅ OK | 在 | WB 独有 | 两平台都有 |
| `glm-5.2` / `glm-5.1` / `glm-4.7` / `glm-4.6` | ✅ OK | 在 | WB 独有 | 两平台都有 |
| `minimax-m3` / `minimax-m2.5` | ✅ OK | 在 | WB 独有 | 两平台都有 |
| `kimi-k2.6` / `kimi-k2.5` / `kimi-k2.8-preview` | ✅ OK | 在 | WB 独有 | 两平台都有 |
| `glm-5v-turbo` | ✅ OK | 在 | WB 独有 | 两平台都有 |
| `deepseek-v4.1-flash` | ✅ OK | 在 | WB 独有 | 两平台都有 |
| `hy3` / `hy3-x` | ❌ param is invalid | 在 | WB 独有 | **真 WB 独有** |
| `hunyuan-chat` / `hunyuan-2.0-thinking` | ❌ param is invalid | 在 | WB 独有 | **真 WB 独有** |
| `glm-5.0` / `glm-4.6v` / `kimi-k2.7` / `kimi-k2-thinking` / `kimi-k3-1` | ❌ param is invalid | 在 | WB 独有 | **真 WB 独有** |
| `deepseek-v4-pro` / `deepseek-v4-flash` | ❌ model is unknown | 在 | WB 独有 | Trae 已下架 |

所以即使 R1 修好，Trae 平台密钥调 `glm-5.3` 仍会被
`platform_mismatch` 拒成 403 —— 症状不变。

**为什么 Trae 目录没覆盖全部**：`get_detail_param` 下发 64 条 config，其中 17 条可见；
`glm-5.2` / `glm-4.6` / `deepseek-v4-pro` 等是 `is_invisible_to_user=true` 的隐藏项，
`kimi-k2.6` / `minimax-m2.5` 则**根本不在目录里**，但 `llm_utils_chat` 实测能调。
只看目录（或只看本地 22 条 `model-config.json` 登记表）都会误判。

---

## 3. 修复

### 3.1 R1：scope 迁移分两路（`src/credentials/api-keys.js`）

- `ensureModelsReadScope()`：NULL/空 → **按平台默认物化**（含 `models:invoke`）；
  显式配过 → 只补 `models:read`。
- 新增 `ensureInvokeScope()`：修「一个 invoke 能力都没有」的坏行（上一版迁移写出的
  `["models:read"]`），按平台默认补齐 invoke，不动用户已有的其它 scope。幂等。
- `src/index.js` 启动时依次执行两者，并打印修复明细。

### 3.2 R2：平台归属事实源（新增 `src/models/platform-ownership.js`）

判定不再依赖单一硬编码名单，而是**证据优先**：

```
traeServes(id) = 实测结论 > Trae 上游目录（含 hidden 项）> 本地登记表 > 可用性表
wbServes(id)   = 实测结论 > WB 动态目录 > WB 静态名单
WB 独占        = wbServes ∧ ¬traeServes        （判据单调）
```

- 「判据单调」是刻意设计：Trae 侧任何一条有效正向证据都会让它不再被判独占，
  修复方向只有一个（证据越全，可用模型越多），不会出现「目录不完整就把可用模型
  整片拒掉」的复发形态。
- 反向安全性由证据本身保证：`hy3` / `hunyuan-chat` 在 Trae 侧目录没有、登记表没有、
  实测明确失败，平台密钥调它们**仍然被拒**，不会越界消耗别家积分。
- 实测结论由三处写入：
  - `scripts/repair-model-key-access.js`（一次性全量取证）
  - `src/jobs/scheduler.js` 探活（每次成功/失败都记）
  - `src/models/catalog.js` / `src/workbuddy/chat.js` 目录同步（写目录快照）
- 状态落 `<workspaceDir>/.trae-api/model-ownership.json`；判定只读内存（每请求热路径，
  不发网络请求）；冷启动读上次留下的快照，判定不随重启退化。
- 过期实测（默认 7 天）不再当证据，让目录/登记表重新接管。

### 3.3 连带修正

- `src/routes/openai.js#resolveKeyPlatform`：通用密钥（`platform=all`）的同名模型
  分派改用归属表 —— `glm-5.3` 走 Trae（此前被分派到 WorkBuddy，白占 WB 配额），
  `hy3` 仍走 WorkBuddy。
- `src/middleware/model-access.js#platformOfModel`：资源路径映射与实际分派同源，
  否则 ACL 与真实路由会漂移（`hy3` 归 `model:trae/*` 会让收窄过 resources 的
  工作密钥被误拒）。
- `src/workbuddy/model-ids.js`（新增）：`WB_MODELS` 名单提为零依赖叶子模块，
  避免 `chat.js ↔ platform-ownership` 的加载期双向依赖（全库双向依赖静态扫描守门）。

---

## 4. 验证

### 4.1 自动化

```
node src/test/unit.test.js      → 303 passed
node src/test/security.test.js  →  53 passed（含 R1/R2 回归用例）
node src/test/raccoon.test.js   →  44 passed
其余 17 个套件全绿（growth / channels / wiring / qoder / protocol / …）
```

新增回归用例（`src/test/security.test.js`）：

- R1：NULL scopes 迁移按平台默认物化（含 invoke）
- R1：`["models:read"]` 坏行被修复为可用密钥
- R2：`glm-5.3` 两平台同名 → 非 WB 独有；`hy3` / `hunyuan-chat` → WB 独有
- R2：Trae 密钥调 `glm-5.3` 放行、调 `hy3` 拒绝
- R2：通用密钥 `glm-5.3` 分派 Trae、`hy3` 分派 WorkBuddy
- R2：`@max` 档位后缀不改变归属

### 4.2 黑盒（修复后代码，端口 19901 侧实例）

```
=== ty (all)          virtual 200 | glm-5.3 200 | doubao-1-6 200 | kimi-k2.6 200 | wb/glm-5.3 200 | wb/hy3 200
=== copyable (wb)     virtual 200 | glm-5.3 200 | doubao-1-6 400(WB 11102，该平台无此模型) | wb/glm-5.3 200 | wb/hy3 200
=== bootstrap-trae    virtual 200 | glm-5.3 200 | doubao-1-6 200 | kimi-k2.6 200 | wb/glm-5.3 403 | wb/hy3 403 | hy3 403
```

即：**平台密钥能调本平台的单个模型**；跨平台与真 WB 独有模型仍被正确拒绝。

### 4.3 归属表落盘内容

`<workspaceDir>/.trae-api/model-ownership.json`：

- `trae.ids`：上游全量 config 名（含 hidden 项），`source=upstream-full-catalog`
- `workbuddy.ids`：WB 动态目录
- `probes.<id>`：逐名字实测结论（`ok` / `note`），本次 32 个 WB 名单项全部实测

---

## 5. 落地步骤

```powershell
# 1) 数据侧修复（幂等；含 32 次上游实测取证，约 1 分钟）
node scripts/repair-model-key-access.js

# 2) 重启生产进程（代码侧改动需重启才生效）
#    Windows 服务 RelayGate（srvany 托管）：以管理员身份执行
Restart-Service RelayGate
#    或手动：start.bat

# 3) 复验
node scripts/repro-key-scope.js
```

> 生产服务由 `srvany.exe` 以服务账号托管，当前会话无权停止它（`Access is denied`），
> 因此第 2 步需在管理员权限下执行；或由服务管理器重启。

---

## 6. 遗留与后续

1. **实测证据的时效**：实测结论 7 天过期后交回目录/登记表。若上游在此期间改了
   模型清单，归属判定可能滞后一个周期。`repair-model-key-access.js` 可随时重跑。
2. **`deepseek-v4-pro` / `deepseek-v4-flash` 在 Trae 侧已下架**（上游回
   `the model is unknown`），但它们仍在本地 `model-config.json` 登记表里。
   归属判定以实测为准（判为 Trae 不服务 → 归 WorkBuddy），但**登记表本身该清理**，
   否则 `resolveModelOptions` 仍会把这两个名字映射到 Trae 通道。
3. **面板未暴露归属视图**：当前只有脚本可见（`ownership.explain(model)` /
   `ownership.stats()`）。若要在面板上展示「某模型归哪个平台」，可加一个只读端点
   复用同一事实源。
