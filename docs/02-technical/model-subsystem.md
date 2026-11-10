# 模型子系统：获取、检测、路由与状态

> 覆盖：上游模型目录怎么来、可用性怎么判、虚拟模型怎么路由、面板状态从哪来。
> 重点解释一个高频疑问：**为什么有些 WorkBuddy 模型状态「不可用」却还在列表里**。

---

## 1. 一张图看数据流

```
上游                    网关                                       对外
────────────────────────────────────────────────────────────────────────────
Trae get_detail_param ─┐
  POST /api/ide/v1/     │
  get_detail_param      │
                        ├─→ catalog.listWithStatus()  ─→ /v1/models        （转发面，客户端用）
WorkBuddy /console/     │      │                          /v1/models/status （管理面，面板用）
  enterprises/          │      │
  personal/models  ─────┘      └─→ autotier.syncAutoTiers() ─→ model-router.json
                                     │                          （vm/* 候选）
                                     ↓
                             availability.json  ←── scheduler 探活（真实调用）
                             model-status.json        admin-debug 手动探活
                                     │
                                     └─→ 面板状态（usable / unavailable / unknown / media）
```

**关键认知**：目录（catalog）与可用性（availability）是**两套独立数据**。

- 目录回答「平台**声称**有哪些模型」；
- 可用性回答「我们**实测**能不能调通」。

两者不同步是常态，不是 bug。下面逐层拆。

---

## 2. 上游模型获取（目录层）

### 2.1 Trae

| 项 | 值 |
|---|---|
| 端点 | `POST {host}/api/ide/v1/get_detail_param` |
| 实现 | `src/models/catalog.js` → `src/upstream/client.js#getModelDetailParam` |
| 缓存 | 10 分钟（`MODEL_CATALOG_TTL_MS`），失败回退 `model-config.json` |
| 返回 | 2026-11-08 实测 **64 条 config**，其中 17 条对外可见 |

过滤规则（`normalizeItem`）：

- `config_switch === false` → 丢弃
- `is_invisible_to_user === true` → 丢弃（**hidden 项**）
- `custom_model_*` / `summary` / `fast_apply` / `title_generation` → 丢弃（工具配置，不是对话模型）
- `model_capability` 不是 `chat_model` / `reasoning_model` → 丢弃

**hidden 项必须单独记住**：`glm-5.2`、`glm-4.6`、`glm-4.7`、`glm-5.1`、`deepseek-v4-pro` 这些在目录里是 `is_invisible_to_user=true`，但 `llm_utils_chat` 实测**能调**。

所以 `models/catalog.js#loadCatalog` 在写归属快照时用的是**全量 config 名**（含 hidden），而不是过滤后的 17 条：

```js
const allNames = detail.config_info_list
  .map((c) => c && c.config_name)
  .filter((n) => n && !isHiddenConfigName(n));
ownership.recordTraeModels(allNames, 'upstream-full-catalog');
```

这就是 2026-11-07 事故（单个模型全 403）的修复点之一：只看 17 条可见项，会把这些名字判成「Trae 不服务」。

### 2.2 WorkBuddy

| 项 | 值 |
|---|---|
| 端点 | `GET {host}/console/enterprises/personal/models` |
| 实现 | `src/workbuddy/chat.js#fetchCatalog` |
| 缓存 | 10 分钟，失败回退静态 `WB_MODELS`（30 条，2026-09-12 快照） |
| 返回 | 2026-11-08 实测 **37 条** |

原始字段（实测）：

```
id, name, credits, maxInputTokens, maxOutputTokens,
supportsToolCall, supportsReasoning, supportsImages, disabledMultimodal,
tags, videoGeneration, relatedModels, vendor, temperature, labels, ...
```

**目录里混着非对话模型**，靠 `tags` / `videoGeneration` 区分：

| id | tags | 类型 |
|---|---|---|
| `hy3` | `craft, badge:限时免费` | 对话 |
| `glm-5.3` | — | 对话 |
| `hunyuan-image-alpha` | `text-to-image` | 图片生成 |
| `kling-video-v3` | `text-to-video, image-to-video` + `videoGeneration{}` | 视频生成 |
| `minimax-video-h3` | 同上 | 视频生成 |
| `hunyuan-image-alpha-edit` | 图片编辑 | 图片 |

分类实现在 `src/workbuddy/chat.js#isChatModel` / `mediaKindOf`，判据优先级：

1. 有 `videoGeneration` 块 → 非 chat
2. `tags` 命中 `text-to-image` / `image-to-image` / `text-to-video` / `image-to-video` / `embedding` → 非 chat
3. id 关键字兜底（静态名单没有 tags）：`/(image|video|kling|audio|tts|embed|rerank)/` → 非 chat

目录条目现在带 `chat: boolean` 与 `mediaKind`，下游全部按它分流。

### 2.3 其余平台

| 平台 | 目录来源 |
|---|---|
| Qoder | 硬编码 `CALLABLE_INTL_MODELS`（实测可调用集合，目录里 `is_free` 不代表可调用） |
| Raccoon | `GET /api/web/llm/v2/model_catalog`（远端动态下发，含限免与倍率） |
| 通用 OpenAI Provider | `GET {baseUrl}/models`，失败回退配置里的 `models` 数组 |

---

## 3. 可用性检测（探活层）

### 3.1 状态机

`src/models/availability.js`，持久化在 `<workspaceDir>/.trae-api/model-status.json`：

```
unknown ──探测成功──→ usable
   │
   └──探测失败（确定结论）──→ unavailable（带 TTL，过期自动回落 unknown）
```

TTL 规则：

| 结论类型 | TTL | 理由 |
|---|---|---|
| 模型级（11102 / 4001 / 11103） | **7 天** | 模型下线是稳定事实 |
| 套餐层（1005 PlanLimit） | **6 小时** | 换号或升级套餐立刻可用，不该藏一周 |
| 网络 / 限流 / 池空 | **不写表** | 不是模型结论 |

### 3.2 探活怎么触发

| 入口 | 实现 | 范围 |
|---|---|---|
| 定时 | `src/jobs/scheduler.js#runModelProbe` | 每 6 小时，每轮最多 8 个（`MODEL_PROBE_MAX_PER_RUN`），只探 `unknown` |
| 手动 | `POST /v1/admin/models/probe`（`routes/admin-debug.js`） | 单个模型 |
| 真实流量 | `routes/openai.js` 成功时 `availability.markUsable(model)` | 隐式 |

### 3.3 错误归因（这是「状态不可用」的来源）

`src/upstream/errors.js#classifyError` 的分类决定写不写状态表：

| 上游响应 | 分类 | 写状态表？ | 结论含义 |
|---|---|---|---|
| `{"code":11102,"msg":"model [x] service info not found"}` | `model` | ✅ unavailable | 目录有、chat 服务没有 |
| `{"code":11103,"msg":"Backend [x] is not supported"}` | `model` | ✅ unavailable | 该模型不是 chat 后端 |
| `{"code":1005}` / `PlanLimit` | `quota` | ✅ unavailable（6h） | 套餐额度不足 |
| `{"code":6004}` / 限流 | `rate_limit` / `model` | ❌ | 稍后重试 |
| `{"code":11128,"msg":"Illegal API invocation..."}` | `channel` | ❌ | 请求形状问题 |
| `{"code":11140,"msg":"request illegal"}` | `account` | ❌ | 账号被风控 |
| 网络 / 超时 / 池空 | `network` / 其他 | ❌ | 本次没探成 |
| `{"code":11115,"msg":"prompt is too long"}` | `context_length` | ❌ | 输入超窗口 |

---

## 4. 路由与虚拟模型

### 4.1 虚拟模型（`vm/*`）

配置在 `model-router.json`，由 `autotier.syncAutoTiers()` 自动生成候选：

| 虚拟模型 | 窗口下限 | 说明 |
|---|---|---|
| `vm/unified-chat` | 116,000 | 全量池（116K ≤ win < 200K） |
| `vm/large-context` | 200,000 | 大窗口池（200K ≤ win < 1M） |
| `vm/long-context` | 1,000,000 | 超长上下文（≥ 1M，Trae 走 `@max` 档） |

候选生成规则（`fetchAllModels`）：

- Trae：只取**可见**且 `contextWindow > 0` 的模型；带 `maxTier` 的额外生成 `<id>@max` 候选
- WorkBuddy：取动态目录里 `maxInputTokens > 0` 的模型（媒体模型天然没有该字段，自动被排除）
- 候选 id 形如 `trae/glm-5.3` / `workbuddy/wb/glm-5.3`

### 4.2 请求路由

`src/model-router/index.js#handleChat`：

```
客户端请求 vm/long-context
  → canUseModel() 权限闸门（平台绑定 + scope + 资源 ACL）
  → checkContextLimit() 虚拟级窗口守门（输入 > 75% × contextWindow → 400）
  → orderCandidates() 候选排序
       ├─ 过滤：provider 启用、候选启用、密钥平台允许、非冷却、非超频
       ├─ 跨池账号权益分档（临期池 > 余额池 > 成本序）
       ├─ 成本序：sort=rate 按倍率升序 / sort=window 按窗口降序
       └─ 轮转池：前 rotateTopN 个加权轮转（权重按倍率反推）
  → autotier.filterCandidatesByInput() 候选级窗口守门
  → dispatch.dispatchStream() 真正发上游
       ├─ 失败且答案未提交 → 切下一个候选（failover.switchOn 决定哪些错误可切）
       └─ 答案已提交 → 补错误帧收尾
```

### 4.3 健康度与冷却

`src/model-router/health.js`，内存态（key = `virtualId::candidateId`）：

| 错误类型 | 冷却 |
|---|---|
| `rate_limit` / `model`（6004） | 按上游报文解析重置时刻，否则 20s |
| `auth` / `quota` | 20s / 1h |
| `account`（11140） | 2 小时 |
| `channel`（11128） | 不冷却（请求形状问题，换候选无用） |
| `context_length` | 不冷却、不切换（终端错误） |

### 4.4 平台归属（2026-11-07 新增）

`src/models/platform-ownership.js`，回答「这个模型名归哪个平台」：

```
traeServes(id)  = Trae 实测结论 > 上游目录（含 hidden）> 本地登记表 > 可用性表
wbServes(id)    = WB 实测结论 > WB 动态目录 > WB 静态名单
WB 独占          = wbServes ∧ ¬traeServes
```

实测结论存在 `<workspaceDir>/.trae-api/model-ownership.json`，7 天过期。

---

## 5. 模型池状态（面板层）

### 5.1 两个端点，两种用途

| 端点 | 鉴权 | 数据源 | 用途 |
|---|---|---|---|
| `GET /v1/models` | access key | Trae catalog + **WB 动态目录**（只列 chat 模型） | 客户端拉模型列表 |
| `GET /v1/models/status` | admin | 同上 + availability + 虚拟模型候选 | 面板「模型池」页 |

**2026-11-08 修正**：`/v1/models` 此前只映射静态 `WB_MODELS`（30 条），与 `/v1/models/status`（动态 37 条）口径分叉。客户端拿到 7 个上游已下架的 id、缺 14 个新增的。现已统一到动态目录。

### 5.2 状态取值

| status | 含义 | 面板显示 |
|---|---|---|
| `usable` | 探测成功过 | 可用（绿） |
| `unavailable` | 探测失败（带 TTL） | 不可用（红） |
| `unknown` | 尚无探测记录 | 未探测（黄） |
| `media` | 图片/视频生成模型，无 chat 端点 | 媒体模型（黄，2026-11-08 新增） |

`media` 这一档是本次新增的：此前媒体模型被 chat 探活写成 `unavailable`，面板长期挂红，用户以为是模型坏了。

---

## 6. 回答问题：为什么「不可用」的 WorkBuddy 模型还在列表里？

**结论：不是「检测失败」，而是三件不同的事被同一个红色状态混在一起了。**

### 情况 A：目录有、chat 服务没有（11102）—— 真·不可用

2026-11-08 现场 8 个：

```
wb/hy4-preview-x   wb/glm-5.0   wb/glm-4.7   wb/glm-4.6
wb/glm-4.6v        wb/minimax-m2.5   wb/kimi-k2-thinking   wb/hunyuan-2.0-thinking
```

这些在**目录里确实存在**（带 `credits`、`maxInputTokens`、`supportsToolCall` 等完整字段），但调 `POST /v2/chat/completions` 返回：

```json
{"code":11102,"msg":"model [glm-5.0] service info not found",
 "retry_policy":{"retry":false}}
```

含义：**售卖清单里有这条商品，但 chat 推理服务端没有对应的 service 配置**。

常见成因：账号套餐不含该模型档位、模型正在灰度/下线、上游目录与推理服务不同步。

我们的处理是正确的：目录里留着（它确实是上游声明的模型），可用性标 `unavailable`，`/v1/models` 默认视图隐藏。

### 情况 B：根本不是 chat 模型（11103）—— 探活方式错

2026-11-08 现场 4 个：

```
wb/hunyuan-image-alpha       tags: text-to-image
wb/hunyuan-image-alpha-edit  tags: 图片编辑
wb/kling-video-v3            tags: text-to-video, image-to-video
wb/minimax-video-h3          tags: text-to-video, image-to-video
```

它们走的是 `hunyuan-stream` / `maas` 后端，**没有 chat 端点**。用 chat 探活必然返回：

```json
{"code":11103,"msg":"Backend [hunyuan-stream] is not supported"}
```

这**不是模型不可用**，是我们的探活方式不适用。

**已修复**：

- `isChatModel()` 分类，探活目标里剔除
- 状态从 `unavailable` 改为 `media`，面板单列一档
- 历史错误结论从可用性表清理
- 虚拟模型候选生成天然排除（它们没有 `maxInputTokens`）

### 情况 C：账号套餐额度不足（1005）—— 账号级结论

Trae 侧 `kimi-k3.1-pro`：

```
PlanLimit: 套餐额度不足 (1005)
```

这是**账号/套餐维度**的状态：换个号、或该账号升级套餐立刻可用。按 7 天 TTL 隐藏会让面板长期看不到一个其实还能用的模型。

**已修复**：TTL 改为 6 小时，`reason` 加 `[套餐层]` 前缀，面板可与「模型下线」区分。

### 汇总表

| 现象 | 上游事实 | 我们的判定 | 是否修复 |
|---|---|---|---|
| 11102 | 目录有、chat 服务无 | 不可用（7 天） | 判定正确，无需改 |
| 11103 | 目录有、非 chat 模型 | ~~不可用~~ → 媒体模型 | ✅ 已修 |
| 1005 | 目录有、账号套餐不足 | ~~不可用（7 天）~~ → 套餐层（6 小时） | ✅ 已修 |
| 网络/限流 | 本次没探成 | 不写表 | 判定正确 |

**所以回答你的问题**：是的，这些模型**上游目录里确实有**；但「状态不可用」有三分之一（11103 那批）是我们自己的探活方式错了，另有三分之一（1005）是账号级结论被记成了模型级。真正的模型不可用（11102）只有 8 个。

---

## 7. 本次修复清单

| 文件 | 改动 |
|---|---|
| `src/workbuddy/chat.js` | 目录条目加 `chat` / `mediaKind` / `tags`；新增 `isChatModel()` / `mediaKindOf()` |
| `src/jobs/scheduler.js` | 探活只探 chat 模型；PlanLimit 短 TTL + `[套餐层]` 标记；目录对账（带截断保护）；媒体模型历史结论清理 |
| `src/models/availability.js` | `markUnavailable()` 支持 `ttlMs` 覆盖；新增 `reconcile()` 按目录清理僵尸条目 |
| `src/routes/models.js` | `/v1/models` 改用动态 WB 目录（只列 chat 模型）；`/v1/models/status` 增加 `media` 档与 `chat`/`mediaKind` 字段 |
| `src/routes/model-router.js` | 候选选择器只列 chat 模型 |
| `web/src/features/models/ModelPoolPage.tsx` | 状态映射与筛选增加「媒体模型」档 |
| `web/src/shared/api/admin.ts` | `ModelInfo` 类型补 `media` / `chat` / `mediaKind` |

### 数据修复

2026-11-08 12:4x 验证 `reconcile()` 时误对生产状态文件调用，清掉了部分 `wb/*` 记录。已按事故前原始内容逐条写回（时间戳沿用原值），并按新口径做了三项**有意**清理：

- 丢弃 4 条媒体模型错误结论
- 丢弃 3 条上游已下架的僵尸条目（`wb/hy4-preview` / `wb/glm-5v-turbo` / `wb/minimax-m3`）
- `kimi-k3.1-pro` 的 PlanLimit 结论 TTL 改为 6 小时

当前状态：56 条（usable 47 / unavailable 9），其中 WB 33 条（usable 25 / unavailable 8）。

---

## 8. 运维速查

```powershell
# 看某模型在两平台的归属与证据
node -e "console.log(require('./src/models/platform-ownership').explain('glm-5.3'))"

# 看可用性表全貌
node -e "console.log(require('./src/models/availability').snapshot())"

# 手动探活单个模型（走真实上游）
curl -X POST http://127.0.0.1:19900/v1/admin/models/probe \
  -H "Authorization: Bearer <ADMIN_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"wb/glm-5.3"}'

# 清掉某模型的可用性结论（下次会重新探）
curl -X DELETE "http://127.0.0.1:19900/v1/models/status?model=wb/glm-5.0" \
  -H "Authorization: Bearer <ADMIN_KEY>"

# 强制刷新上游目录
curl -X POST http://127.0.0.1:19900/v1/models/refresh \
  -H "Authorization: Bearer <ADMIN_KEY>"
```
