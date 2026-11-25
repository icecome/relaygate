# SRC-01 WorkBuddy 账号池「N 个账号需重新登录」误报：refreshToken 到期记录与真实凭据生命周期脱钩

| 项 | 内容 |
|---|---|
| 编号 | SRC-01 |
| 发现时间 | 2026-11-25 |
| 目标 | RelayGate v3.1.0（本地自建网关，Express + `node:sqlite`） |
| 影响面 | 管理面板「凭据池 / 总览」告警可信度；账号轮换的失效判定提示 |
| 严重等级 | **Medium**（`grade=session`：需已登录管理面；无凭据泄露、无越权、无数据损坏） |
| CWE | CWE-1288 Improper Validation of Consistency within Input |
| OWASP | A04:2021 Insecure Design |
| 状态 | 已复现 · 已定位 · 已修复 · 已回归 |

---

## 1. 现象

网关面板「凭据池」顶部统计条与「总览 → 待处理」同时显示：

> **7 个账号需重新登录**

用户按提示重新登录了其中一个账号（`18932771517`），提示数量与红色标记**均未消失**，该行仍报「需重新登录」。

问题因此收敛为一句可判定的话：**这 7 个账号的 refreshToken 是真到期，还是本地记录误报？**

---

## 2. 结论（先给答案）

**误报。** 8 个 WorkBuddy 账号的凭据全部有效，当日 1291 次转发 0 个 401。
真正过期的是数据库里的 `refresh_expired_at` 这一列 —— 它只在**导入那一刻**写过一次，此后所有续期链路都不回写它，导入满 30 天（refreshToken 的寿命）后必然跨过 `now`，于是前端永久判「需重新登录」。

重新登录之所以无效：重登/续期只更新 `token` 与 `expired_at`，那两列本来就对，问题列没人碰。

---

## 3. 三点闭合证据

### 3.1 根因（rationale）

`refresh_expired_at` 是「凭据生命周期列」，但它的写入源与凭据本体的更新源不一致：

- refreshToken 每次续期都会**滚动换发**一个新的、30 天有效的新值，旧值立刻作废；
- 而记录它到期时刻的这一列，只有导入路径会写：

| 链路 | 是否回写 `refreshExpiredAt`（修复前） |
|---|---|
| `src/credentials/import.js:127`（粘贴/导入） | ✅ 写 |
| `src/routes/workbuddy.js#POST /import` | ❌ 不写 |
| `src/jobs/auth-sync.js`（客户端凭据同步） | ❌ 不写 |
| `src/auth/index.js#ensureAuth`（按需续期） | ❌ 不写 |
| `src/jobs/rotate-accounts.js#verifyRefresh`（轮换前验续期） | ❌ 不写 |
| `src/routes/workbuddy.js#POST /refresh`（面板「刷新 Token」） | ❌ 不写 |

只要有任何一次导入把该列写成一个**绝对时刻**，这个时刻在 30 天后必然成为过去，并且再也没有任何代码能把它纠正回来 —— 这就是一个只增不减、永不自愈的错误状态。

同时有两处读侧缺陷把它锁死：

1. `src/workbuddy/auth.js#readAuthFile()` 只读 `refreshExpiresIn`（相对秒数），忽略客户端文件里现成的绝对时间戳 `refreshExpiresAt`。拿 10 月 26 日写下的文件里的「剩余 716 小时」加 `now`，会把已到期的凭据算到 2027 年去 —— 同一个病根，反方向发作。
2. 上游续期响应**不返回** `refreshExpiresAt`，写侧即使想补也没有字段可取，必须从新 refreshToken 的 JWT `exp` 推导。

### 3.2 可达性（reachable）

纯本地状态判定，无前置条件：管理面已登录用户打开「凭据池」或「总览」即触发。判据链：

```
GET /v1/credentials  →  refreshExpiredAt（DB 列）
        ↓
web/src/features/accounts/accountPacks.tsx#keepaliveOf()
        ↓  refreshExpiresMs <= now
   { label: '需重新登录', tone: 'danger' }
        ↓
CredentialsPage stats.needRelogin / OverviewPage issues.needLogin
```

### 3.3 证据（evidence）

**① DB 列值 vs refreshToken JWT exp（真值）**

```
label        | db_refresh_expired_at      | rt_jwt_exp(真值)           | 偏差     | 判定
18630893389  | 2026-11-25T04:02:38.673Z   | 2026-12-24T08:50:10.000Z   | -700.8h  | NEED_RELOGIN
18032213389  | 2026-12-25T04:02:39.243Z   | 2026-12-24T09:06:45.000Z   |  +18.9h  | -
19075795328  | 2026-11-25T04:02:36.318Z   | 2026-12-24T08:53:29.000Z   | -700.8h  | NEED_RELOGIN
173****5927  | 2026-11-25T04:02:36.814Z   | 2026-12-25T04:58:30.000Z   | -720.9h  | NEED_RELOGIN
18932771517  | 2026-11-25T04:02:38.335Z   | 2026-12-25T01:14:24.000Z   | -717.2h  | NEED_RELOGIN
15833374517  | 2026-11-25T04:02:38.813Z   | 2026-12-24T08:58:27.000Z   | -700.9h  | NEED_RELOGIN
18232808772  | 2026-11-25T04:02:39.321Z   | 2026-12-24T09:23:27.000Z   | -701.3h  | NEED_RELOGIN
18103270786  | 2026-11-25T04:02:39.820Z   | 2026-12-24T09:29:18.000Z   | -701.4h  | NEED_RELOGIN
```

7 行的库内值全部落在 `2026-11-25T04:02:3x` —— 同一秒级窗口内的同一次批量写入，是「一次性导入」的指纹，不是 7 次独立的真实到期。而同一批 refreshToken 的 JWT `exp` 都在 2026-12-24/25，**还有 29 天**。

**② 在线验真：凭据是活的**

```
18630893389   billing=OK bal=3581.49
18032213389   billing=OK bal=2970.55
19075795328   billing=OK bal=3480.73
173****5927   billing=OK bal=3082.41
18932771517   billing=OK bal=2886.92   ← 用户重登的那个号
15833374517   billing=OK bal=2658.34
18232808772   billing=OK bal=2986.33
18103270786   billing=OK bal=2779.08
```

**③ 负向对照：当日流量 0 个 401**

`logs/2026-11-25/traffic.jsonl` 共 2472 行，其中 workbuddy 转发 **1291 次，HTTP 200 共 1291 次，401 共 0 次**。若 refreshToken 真的过期，续期会 401 → 上游判失效 → 大量转发失败，实际一次都没有。

**④ 上游续期响应实测**

对 `18932771517` 实际发起一次 `POST /v2/plugin/auth/token/refresh`：

```
上游续期响应字段: [ 'accessToken', 'refreshToken', 'expiresAt' ]
  返回的 expiresAt      : 2026-12-23T05:32:48.750Z
  返回 refreshExpiresAt : （未返回，undefined）

新 accessToken exp  : 2026-12-23T05:32:50.000Z
新 refreshToken exp : 2026-12-25T05:32:50.000Z   ← 唯一可离线推导的权威值

回写后库内 refreshExpiredAt: 2026-11-25T04:02:38.335Z （续期链路没有写它 → 仍是陈旧值）
```

这一条同时钉死两件事：续期响应里没有 `refreshExpiresAt` 字段（写侧无从直接取），以及续期成功后库内该列纹丝不动（写侧确实没写）。

**⑤ 前端判据复现**

复刻 `keepaliveOf()` 逻辑跑一遍本地库：

```
label        | tone    | 该值何时跨过 now | db_rt
18630893389  | danger  | 1.5h 前           | 2026-11-25T04:02:38.673Z
...
前端「需重新登录」计数 = 7
```

计数与面板显示的 7 完全一致 —— 判据链闭合，面板数字确实由这一列驱动。

**⑥ 「重登无效」的直接复现**

用户重登 `18932771517` 后：

```
last_refresh_at      = 2026-11-25T01:14:53.547Z   ← 更新了
expired_at           = 2026-12-23T01:14:53.547Z   ← 更新了
refresh_expired_at   = 2026-11-25T04:02:38.335Z   ← 未变（仍是导入时的值）
```

重登动作更新了两列正确的、唯独没碰那一列错的。这就是「重登了但提示不消失」。

---

## 4. 影响

1. **告警失去可信度**：7 条假告警常驻，真实掉线的账号被淹在里面，用户无法据此判断账号池健康度。
2. **唯一自救动作被证伪**：面板给出的建议是「重新登录」，而这个动作对该提示无效 —— 用户会反复重登、反复怀疑账号池已大面积失效。
3. **误导轮换决策**：`rotate-accounts` 的失效提示文案（「refreshToken 已失效，请重新登录该账号」）与面板判据同源，会把运维往错误方向引。
4. 不涉及凭据泄露、越权、数据损坏 —— 因此定级 Medium 而非 High。

---

## 5. 修复

四层，缺一层都会复发。

### 5.1 写侧：让「到期时刻」跟着 refreshToken 一起滚

`src/workbuddy/auth.js#refresh()` —— 续期响应没有 `refreshExpiresAt`，从新 refreshToken 的 JWT `exp` 推导并返回：

```js
const nextRefreshToken = data.refreshToken || data.refresh_token || refreshToken;
const refreshExpiresAtMs = jwtExpMs(nextRefreshToken)
  || (data.refreshExpiresAt ? Number(data.refreshExpiresAt) : null);
return {
  accessToken,
  refreshToken: nextRefreshToken,
  expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  refreshExpiresAt: refreshExpiresAtMs ? new Date(refreshExpiresAtMs).toISOString() : null,
};
```

`jwtExpMs()` 新增于同文件：

```js
function jwtExpMs(token) {
  try {
    const seg = String(token || '').split('.')[1];
    if (!seg) return null;
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    return payload && payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}
```

五个回写点全部补上 `refreshExpiredAt`（取不到时**不覆盖**，避免把已有值抹成 null）：

| 文件 | 位置 |
|---|---|
| `src/auth/index.js` | `ensureAuth()` workbuddy 分支 |
| `src/routes/workbuddy.js` | `POST /refresh`（面板「刷新 Token」） |
| `src/routes/workbuddy.js` | `POST /import`（导入时按归一化后的绝对值写入） |
| `src/jobs/rotate-accounts.js` | `verifyRefresh()` 返回值 + 两处 `store.update` |
| `src/jobs/auth-sync.js` | 客户端凭据同步的 add 与 update 两支 |

### 5.2 读侧：认绝对时间，别拿相对秒数当绝对时刻

`src/workbuddy/auth.js#readAuthFile()` 取值优先级改为：

```
1) 文件里的绝对时间戳 expiresAt / refreshExpiresAt（客户端自己算好的）
2) JWT 的 exp（上游签发时刻，同样绝对）
3) 最后才用 expiresIn / refreshExpiresIn 相对秒数兜底
```

`src/jobs/auth-sync.js` 同步同口径，抽出 `expiryFromAuthFile()` 供建号与更新两支共用。

### 5.3 存量：启动时按真值校正

新增 `src/credentials/refresh-expiry.js`：

```js
function repairWorkbuddyRefreshExpiry() { /* ... */ }
```

判定：库内值与 refreshToken 的 JWT `exp` 偏差超过 1 小时即纠正，**两个方向都纠**：

- `stale_expired`：库内已过期但 token 还活着 → 本次事故形态；
- `optimistic`：库内值比真值更晚 → 到期告警被推迟，凭据悄悄死掉才被发现，比前者更危险。

`missing`（列为空）也按真值补齐。`refreshToken` 缺失 / 非 JWT / 无 `exp` 时一律不动 —— 无法证伪就不改。

挂到 `initCredentials()`（由 `src/index.js` 启动流程调用），幂等。

### 5.4 判据：让「记录过期」能被之后的成功续期反证

`web/src/features/accounts/accountPacks.tsx#keepaliveOf()`：

```ts
if (refreshExpiresMs != null && refreshExpiresMs <= now) {
  const staleRecord = lastRefreshMs != null && lastRefreshMs > refreshExpiresMs;
  if (staleRecord) {
    return { ..., label: '到期记录陈旧', tone: 'warn' };
  }
  return { ..., label: '需重新登录', tone: 'danger' };
}
```

`web/src/features/overview/OverviewPage.tsx#issues` 同步拆成 `needLogin` / `staleRecord` 两个计数，不再把陈旧记录混进「需重新登录」。

界面上「到期记录陈旧」是 warn 级独立计数，文案明确指向「点该行『刷新 Token』即可刷新记录，无需重新登录」。

---

## 6. 复现 / 验证

### 6.1 只读复现（不改库）

```bash
cd /c/opt/workstations/project/web/RelayGate

# ① 库内列值 vs JWT exp 真值
node output/_diag_wb_rt.js

# ② 复刻前端判据，确认计数
node output/_diag_wb_timeline.js

# ③ 在线验真，证明账号是活的
node -e "process.env.WORKSPACE_DIR='./output';
const s=require('./src/credentials/store'),wb=require('./src/workbuddy/auth');
(async()=>{for(const x of s.list().filter(a=>a.edition==='workbuddy')){
  const a=s.get(x.id);
  const r=await wb.verify({accessToken:a.token,uid:a.userId,region:'cn'});
  console.log(a.label,r.valid,r.balance);}})()"
```

### 6.2 修复 + 存量校正（写库，先备份）

```bash
cp output/.trae-api/trae-relay.db \
   output/.trae-api/trae-relay.db.bak-$(date +%Y%m%d-%H%M%S)

node -e "process.env.WORKSPACE_DIR='./output';
console.log(JSON.stringify(
  require('./src/credentials/refresh-expiry').repairWorkbuddyRefreshExpiry(), null, 1))"

# 幂等复跑，应为 repaired: 0
node -e "process.env.WORKSPACE_DIR='./output';
console.log(require('./src/credentials/refresh-expiry').repairWorkbuddyRefreshExpiry())"
```

### 6.3 契约测试

```bash
node src/test/wb-refresh-expiry.test.js
```

16 项断言，钉住四件事：JWT exp 是真值；相对秒数不能当绝对时间；`readAuthFile` 优先级；「记录已过期」必须能被 `lastRefreshAt` 反证；修复幂等且修复后全库与 JWT exp 一致。

已并入 `npm test`。

---

## 7. 修复效果

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `needRelogin` 计数 | 7 | **0** |
| 8 个账号 `keepaliveOf().tone` | 7×danger + 1×ok | **8×ok** |
| 库内 `refreshExpiredAt` 与 JWT exp 偏差 | -700 ~ -720h（7 行） | **0.0h（8 行全一致）** |
| 凭据可用性（billing） | 8/8 OK | 8/8 OK（未变，本就不是凭据问题） |
| 存量修复 | — | 7 行 `stale_expired` + 1 行 `optimistic`，幂等复跑 0 改动 |

### 回归

```
npm test                       332 + 16(wb-refresh-expiry) + 19(wb-oauth) + 25(overview)
                               + 21(entitlement) + 54(channels) + 24(wiring) ... 全通过
web: npx tsc -b                exit 0
web: eslint .                  无输出（通过）
biome check（改动文件）         无 error
```

---

## 8. 同类风险与后续建议

1. **`tokenReleaseAt` 是同一形态的陈旧列**：同样只在导入时写、续期不回写。目前无读侧消费，暂不构成缺陷，但一旦有界面读它就会重演同一事故。建议并入 `refresh-expiry.js` 统一从 JWT 派生。
2. **`Qoder` 的 `refreshExpiredAt` 不属同一缺陷**：它在导入时写入，且 Qoder 的 `keepaliveMode` 是 `not-implemented`（真会过期、网关不续期），面板报「到期需手动更新」是如实描述。
3. **原则性收口**：所有「凭据生命周期列」应改为**从凭据本体派生**、由**单一函数写入**，并在读侧保留一条「能否被后续成功事件反证」的自检 —— 本次事故的本质不是某一行代码漏写，而是「同一事实存在两个不同步的存储位置」。
