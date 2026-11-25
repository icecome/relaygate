## 4. 低危问题（L-01 ~ L-08）

---

### L-01 `isEnvLogin` 使用非恒定时间比较

| 项 | 内容 |
|----|------|
| **文件** | `src/middleware/auth.js:35-41` |
| **等级** | 🔵 低危 |
| **类型** | 时序侧信道（CWE-208） |

**问题描述**

```js
function isEnvLogin(token) {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && token === adminKey) return true;   // :39  === 短路比较
  return false;
}
```

`===` 对字符串逐字符比较并在首个差异处返回。理论上可通过响应时间差逐字节推断 `ADMIN_KEY`。本项目在 `credentials/oauth.js:108` 已对 state 使用 `crypto.timingSafeEqual`，说明团队掌握该手法，此处不一致。

**实际可利用性低**：网络抖动远大于纳秒级差异，且 `ADMIN_KEY` 通常是 32+ 字节随机串。属纵深防御项。

**修复建议**

```js
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return require('crypto').timingSafeEqual(ba, bb);
}
function isEnvLogin(token) {
  const adminKey = process.env.ADMIN_KEY;
  return !!adminKey && safeEqual(token, adminKey);
}
```

（`middleware/auth.js` 顶部已 `require` 了 `config`，可改为引入 `node:crypto`；注意长度不等时直接 `false` 本身泄露长度，但因密钥长度固定，影响可忽略。）

---

### L-02 日志脱敏按**键名**匹配，不按值特征识别

| 项 | 内容 |
|----|------|
| **文件** | `src/log/traffic.js:41-60` |
| **等级** | 🔵 低危 |
| **类型** | 敏感信息可能绕过脱敏（CWE-532） |

**问题描述**

```js
} else if (/authorization|token|password|secret|api[_-]?key/i.test(k)) {
  out[k] = maskSecret(v);           // 只看键名
```

键名不含上述关键词但值本身是凭据的字段不会被脱敏。已核查当前调用点（`logRequest` 的 entry 由各路由显式构造，无用户可控的任意键名），**当前无实际泄露**；但该机制对未来新增字段是 fail-open 的。

同时 `maskSecret`（`lib/mask.js:17`）对 `length <= 12` 返回 `'***'`，对更长的值保留首 6 + 尾 4——对 1361 字符的 WorkBuddy accessToken，保留 10 个字符是合理的；但对恰好 13 字符的密钥会暴露 10/13。

**修复建议**

1. 增加值特征兜底：匹配 `sk-[A-Za-z0-9]{16,}`、`eyJ[A-Za-z0-9_-]{10,}`（JWT）、`dt-[A-Za-z0-9]{16,}` 等已知前缀的字符串值一律打码。
2. `maskSecret` 的阈值从 12 提到 24，`<=24` 直接全掩码。
3. 加单测：构造含 `{foo: 'sk-abcdef...'}` 的 entry，断言输出不含明文。

---

### L-03 `bpdy-parser` 4xx 分支透传 `err.message` 至客户端

| 项 | 内容 |
|----|------|
| **文件** | `src/index.js:321-334` |
| **等级** | 🔵 低危 |
| **类型** | 信息泄露（CWE-209） |

**问题描述**

```js
if (err && err.type && s >= 400 && s < 500) {
  ...
  return res.status(s).json({
    error: { message: `${hint} 原始原因：${String(err.message).slice(0, 300)}`, ... },
  });
}
```

`entity.parse.failed` 的 `err.message` 由 Node 生成、**含请求体片段**（实测 `Unexpected token 'S', "SUPER_SECR"...`）。虽然这是调用方自己发的内容，回给调用方本身无泄露；但该响应对**任何持有 access key 的人**可见，若日志/代理中转该响应会扩散用户内容。

严格来说这一设计是刻意的（`:318-319` 注释说明目的是避免把"客户端发了非法 JSON"误诊为"上游故障"），且对排障有实际价值。故列为低危而非缺陷。

**修复建议** 保留现有可诊断性，但把 `原始原因` 限制为错误**位置信息**而非内容片段：

```js
const pos = err.message.match(/at position (\d+)/);
const detail = pos ? `语法错误，位置 ${pos[1]}（第 ${pos[1]} 字节附近）` : 'JSON 语法错误';
```

这样既保留"是解析错误"的诊断价值，又不回显请求体。

---

### L-04 `probes/` 脚本含疑似真实手机号与密码字面量

| 项 | 内容 |
|----|------|
| **文件** | `scripts/verify/verify-review-fixes.js:94` |
| **等级** | 🔵 低危 |
| **类型** | 凭据/个人信息硬编码（CWE-798） |

**问题描述**

```js
{ phone: '18630893389', password: 'SuperSecret123' });
```

该文件在 `scripts/verify/` 下（会被 `npm run verify:review-fixes` 执行），非一次性探针。手机号形似真实号码（`186` 段），密码为占位性质。

**影响** 若手机号为真实号码，构成 PII 泄露；两字段均应替换为明显的测试假值。已入库（`scripts/` 属项目资产，见 `.gitignore` 注释），故需在代码层修正而非仅靠忽略。

**修复建议**

```js
{ phone: '13800000000', password: 'test-only-fake-pw' });
```

并加一行注释说明"仅用于本地校验入参格式，不对应任何真实账号"。建议全仓再扫一遍真实手机号模式（`1[3-9]\d{9}`），排除 `logs/` 与文档中的示例。

---

### L-05 多个管理端点的 `label` 等字符串字段无长度上限

| 项 | 内容 |
|----|------|
| **文件** | `src/routes/api-keys.js:73,92,112-126`；`src/credentials/api-keys.js:128-180` |
| **等级** | 🔵 低危 |
| **类型** | 输入校验缺失（CWE-20） |

**问题描述**

```js
// src/routes/api-keys.js:73
const label = (req.body && req.body.label) || 'login';
const created = apiKeys.createKey({ label, kind: 'login' });
```

`createKey` 内部（`api-keys.js:162-169`）把 `label` 原样写入 SQLite，**无 `String()` 归一、无长度上限、无类型校验**。若传入对象，better-sqlite3 风格的绑定会抛错（有 try/catch 兜底转 400），但传入 10 MB 字符串会直接落库，并在所有列表接口回显。

对比 `routes/credentials.js:522` 对 `name` 做了净化（`.replace(/["'`;\\]/g,'').trim().slice(0,60)`），口径不一致。

**影响** 存储膨胀 + 界面渲染异常。需管理权限，故低危。

**修复建议** 在 `createKey`/`updateKey` 内统一归一：

```js
function normalizeLabel(v) {
  if (v == null) return null;
  return String(v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || null;
}
```

---

### L-06 前端多处 `eslint-disable react-hooks/exhaustive-deps` 掩盖依赖缺失

| 项 | 内容 |
|----|------|
| **文件** | `web/src/features/accounts/WbOauthDialog.tsx:61`、`KeyPolicyDialog.tsx:111`、`web/src/features/models/ProviderDialog.tsx:122`、`web/src/shared/hooks/useAsyncData.ts:81`、`web/src/shared/ui/Menu.tsx:137` |
| **等级** | 🔵 低危 |
| **类型** | 闭包捕获过期值（CWE-1104） |

**问题描述**

`WbOauthDialog.tsx:61` 的 2 秒轮询 effect 显式禁用了依赖检查。若闭包内读取的 `key`/`url` 在轮询期间变化，effect 不会重启，会继续轮询**旧**会话。

`useAsyncData.ts:81` 的 `}, [enabled, nonce, ...deps]);` 是变长依赖数组——依赖项数量在运行期变化，React 对数组长度变化的行为是未定义的（会触发 hook 数量变化警告），且禁用 lint 后无人能发现。

**影响** 特定交互序列下出现"轮询旧数据""请求未刷新"。已核查 `useAsyncData` 的当前调用方（`AccessKeysPage` 等）传入的是稳定字面量数组，**当前无实际 bug**，但该 hook 是一个待引爆的隐患。

**修复建议**

1. `useAsyncData` 改为接收序列化 key：`useAsyncData(fn, [key], ...)` → 内部 `const depKey = JSON.stringify(deps)`，effect 依赖 `[enabled, nonce, depKey]`。彻底消除变长数组。
2. `WbOauthDialog` 的轮询改用 `useRef` 持有最新 `key`/`url`，或把轮询逻辑移入依赖正确的 `useEffect`。

---

### L-07 超大文件：可维护性风险集中区

| 项 | 内容 |
|----|------|
| **文件** | 见下表 |
| **等级** | 🔵 低危 |
| **类型** | 可维护性 / 认知复杂度（Fowler: Divergent Change） |

**问题描述**

| 文件 | 行数 | 问题 |
|------|------|------|
| `web/src/features/ops/OpsPage.tsx` | 1732 | 单文件承载 5 个分段的全部渲染与状态 |
| `src/jobs/scheduler.js` | 1116 | 签到 + 保活 + token 巡检 + 模型探活 + 轮换 + 成长轮询共 6 类任务 |
| `web/src/features/accounts/CredentialsPage.tsx` | 1119 | 列表 + 筛选 + 13 个弹窗 |
| `src/credentials/pool.js` | 946 | 选号策略 + 冷却 + 限速 + 快照 |
| `src/routes/openai.js` | 886 | Trae/WB/Qoder/Raccoon 四条分派分支 + 流式/非流式 |
| `src/platform/variant.js` | 823 | 5 平台变体常量表 |
| `src/model-router/dispatch.js` | 817 | 候选派发 + 闸门 + 心跳 |

`src/` 中 >400 行的文件有 18 个（前端同理）。这些文件符合 Fowler 的 **Divergent Change**（一个文件因多个不相关原因被修改）。

**影响** 改动易回归；本次审计中 `qoder.js` 的注释与实现脱节（H-02）正是"文件大、同类逻辑分散"的直接后果。

**修复建议** 按"变更原因"而非"技术层次"拆分。优先级最高的是 `scheduler.js`（6 类任务应各自独立文件 + 一个注册表）与 `routes/openai.js`（4 条分派分支可抽到 `routes/handlers/`）。不建议为拆分而拆分；以"下次改它时顺手拆"的方式渐进推进更务实。

---

### L-08 注释与实现漂移（多处）

| 项 | 内容 |
|----|------|
| **文件** | 见下 |
| **等级** | 🔵 低危 |
| **类型** | 文档失真（误导后续维护者） |

**问题描述**

本项目注释密度极高且质量普遍优秀（多数注释解释了"为什么"而非"是什么"），但已发现 2 处与实现不符：

1. **`src/routes/qoder.js:6-9`** —— 声明 `/chat/completions` 挂 `authenticate + keyRateLimit`，实际只有 `authenticate`（见 H-02）。
2. **`src/config.js:247-251`** —— `toolProtocol` 的注释坦承"当前仅用于展示，没有任何行为分支消费它"。这是**诚实的自述**，但也意味着该配置项是死代码，应在面板上标注"未生效"或移除（类似 `model-fallback.json` 已做的处理，见 `config.js:84-98` 的详尽说明）。

**已核验排除的疑点**（记录以免后续重复怀疑）：`src/index.js:163-164` 的 `isDocumentRoute` 注释称"转发面与运维快照不是 HTML 文档"，实现为 `!p.startsWith('/v1/') && p !== '/status' && p !== '/health'`——与注释**完全一致**，不存在漂移。

**修复建议**

1. 修正 `qoder.js` 注释或补上实现（优先补实现，见 H-02）。
2. `toolProtocol` 按 `model-fallback.json` 的既有先例处理：要么接入行为分支，要么在 `/v1/admin/config` 与面板上显式标注"未生效"。

---
