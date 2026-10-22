# 事故记录：测试污染真实状态库（2026-10-14）

> 本文记录一次**由本次优化改动直接引发**的数据事故，含根因、影响面、已执行的修复与
> 防复发措施。留档的目的是：同类错误的代价是「真实账号库被写脏」，不是「测试红了」。

## 1. 事故经过

为修复缺陷 D8（`config.reload()` 的 `.env` 热加载是空操作），把 `src/config.js` 里的
`.env` 加载从

```js
require('dotenv').config()                    // 第二次调用被 dotenv 的「不覆盖已存在键」挡住 → 空操作
```

改成

```js
require('dotenv').config({ override: true })  // ← 错：.env 反过来压掉调用方显式设置的环境变量
```

`override: true` 让 `.env` **反向覆盖**了进程环境变量。而各测试文件靠「在 require 之前
设置 `WORKSPACE_DIR` 指向临时目录」实现隔离，仓库 `.env` 里恰好也有
`WORKSPACE_DIR=./output`，于是：

1. 测试的临时目录被 `.env` 的 `./output` 覆盖；
2. 测试的 `store / import / backup / restore` 用例全部作用在**真实** `output/.trae-api/`
   状态目录上；
3. 测试密钥 `TRAE_API_ENCRYPT_KEY='a'×64` 与真实 `encrypt.key` 不同，读真实凭据报
   `Unsupported state or unable to authenticate data`，而**写**则用假密钥落进了真实库。

受影响运行：`protocol.test.js`（1 次）、`npm test` 全量（1 次）、`unit.test.js`（3 次），
集中在 13:06–13:08。

## 2. 影响面（实测确认）

| 对象 | 影响 | 现状 |
|---|---|---|
| `output/.trae-api/trae-relay.db` → `accounts` | **写入 73 行测试账号**（假标签 `imp-1`/`a1`/`bal-low`/`sig-a`…，`enabled=1`，用假密钥加密） | **已清理**，剩 17 行真实账号 |
| 同上 → `api_keys` | 无损失。`restore` 用备份覆盖过，17 行与备份一致；带 `t-*` 标签的密钥创建于 01:24–01:36Z，早于本次事故，属用户自建 | 未改动 |
| 同上 → `credit_history` | 无测试账号行（6162 行全部属于 17 个真实账号） | 未改动 |
| 同上 → `audit_log` | 4 行 `action: "test.action"`（id 13–16） | **保留**（见 §5） |
| `output/.trae-api/task-log.jsonl` | ~25 行虚构任务记录（`backup`/`restore`/`keepalive`/`checkin`，`trigger: manual`，05:06–05:07Z） | **保留**（见 §5） |
| `backups/relay-backup-2026-10-14T05-0*.json` | 5 个测试创建的备份（含 73 个假账号） | **已隔离**至 `backups/_test-artifacts-20261014/` |
| `output/.trae-api/backup-state.json` | 被测试改写，`lastBackupFile` 指向一个测试备份 | **已隔离**（同上目录） |
| 其它状态文件 | `model-router.json`（4 个真实虚拟模型）、`model-status.json`、`notify-settings.json`、`scheduler-settings.json`、`balance-refresh-settings.json`、`growth-last-run.json` | **内容经逐项核对为真实值，未被测试值覆盖** |

**真实账号零损失**：17 行真实账号全部可用真实密钥 `encrypt.key` 正常解密
（`encrypt.key` mtime 仍为 2026-09-10，从未被改写）。

## 3. 已执行的修复

1. **修正 `.env` 加载语义**（`src/config.js`）：不再用 `override: true`，改为按
   「进程启动时真实存在的环境变量名」逐个键判定——`BOOT_ENV_KEYS` 里的键永不覆盖，
   其余键每次加载按文件现值刷新。既修好 D8（reload 真的生效），又不越权覆盖。
2. **`BOOT_ENV_KEYS` 以进程为单位快照一次**（挂 `globalThis[Symbol.for(...)]`）：
   `unit.test.js:921` 会 `delete require.cache[config]` 重新加载 config，模块级常量会
   重新快照，把 `.env` 注入的键误判为「进程环境显式给出」，reload 又变空操作。
   此问题在写回归测试时被当场捕获。
3. **清理真实库**：删除 73 行测试账号（判据：真实密钥解密失败 **且** 标签命中测试名；
   两条独立证据同时成立）。删除后 `/health` 实时显示 `accounts.total=17, enabled=16`。
4. **隔离有危害的残留**：5 个测试备份 + 被改写的 `backup-state.json` 移入
   `backups/_test-artifacts-20261014/`。**这一步是必要的**：`backup-state.json` 指向
   测试备份，用户在面板点「恢复最新备份」会把 73 个假账号带回来。
5. **护栏**（`src/test/isolation-guard.js`）：require 即判定 `WORKSPACE_DIR` 是否在
   临时目录内、`TRAE_API_ENCRYPT_KEY` 是否已设置、`config.workspaceDir` 实际解析结果
   是否仍在临时目录内；任一不满足直接 `exit(1)`，绝不进入测试体。
6. **补 `qoder.test.js` 的隔离缺口**：10 个测试文件里它是唯一没设 `WORKSPACE_DIR` 的。
7. **回归测试 2 条**（`unit.test.js`）：① 进程环境显式给出的键不被 `.env` 覆盖（含
   reload）；② `.env` 提供过的键在 reload 时按文件现值刷新。
8. **顺带修掉同类隐患**：`config.workspaceDir` 原先原样返回 env 值（`.env` 里是
   相对的 `./output`），而 `credentials/db.js` 直接用它拼 DB 路径——换个 cwd 启动会
   静默打开另一个库（表现为「账号全丢了」）。现统一 `path.resolve(ROOT, ...)`。

## 4. 防复发验证

- 护栏变异测试：不设 `WORKSPACE_DIR` 时 `exit=1` 并打印三条具体原因；正常设置时放行。
- 全量测试：`npm test` → 10 个文件全绿（246 + 64 + 11 + 41 + 15 + 11 + 9 + 7 + 5 + 14），exit 0。

## 5. 有意**未**删除的内容

- `audit_log` 的 4 行 `test.action`、`logs/2026-10-14/audit.jsonl` 的同样 4 行：
  审计日志的价值在于「不可删改」。它们是本次事故的**证据**，删掉会让审计链失真；
  且 `action: "test.action"` 自证其为测试产物，不会误导阅读。
- `task-log.jsonl` 的 ~25 行虚构任务记录：同理保留为证据。它们会出现在面板的
  任务日志里（时间集中在 2026-10-14T05:06–05:07Z），如需清理请单独确认。

## 6. 若需回滚

- 隔离的备份与 `backup-state.json`：`backups/_test-artifacts-20261014/`（移动，非删除）。
- 本次事故前的数据库快照（含污染后的 90 行，仅考古用）：
  `output/.trae-api/pollution-snapshot-20261014-130821/`。

## 7. 排查中发现的相邻缺陷（既有，非本次引入）

### D12：日志目录不走 `workspaceDir`，测试流量行进了真实统计

`src/lib/paths.js` 的原则是「状态目录 = `<workspaceDir>/.trae-api`」，`lib/crypto.js`、
`jobs/*`、`credentials/db.js` 都已遵守，`log/audit.js` 也用 `config.workspaceDir`。
但同属运行期状态的**日志**分成了两处：

| 写入方 | 目录 |
|---|---|
| `log/traffic.js#todayDir` | `path.resolve(__dirname,'..','..')` → `<ROOT>/logs`（**硬编码 ROOT**） |
| `log/crash.js#todayDir` | `<ROOT>/logs` |
| `upstream/client.js#sseDebugWrite` | `config.ROOT` |
| `routes/admin-debug.js` SSE 查询 | `config.ROOT` |
| `log/stats.js#readTrafficLines` | `config.ROOT` |
| `log/audit.js#jsonlFile` | `config.workspaceDir` | 

后果：设置 `WORKSPACE_DIR` 隔离不了日志。实测 `npm test` 会往真实
`logs/2026-10-14/traffic.jsonl` 追加 `model=test`、`model=vm/sec-guard` 之类的行，
并往 `crash.jsonl` 追加 `lifecycle/shutdown_done`、`security/oauth_callback_rejected`。
这些行会被 `/v1/admin/stats/*` 读进**统计面板与热力图**——不是纯日志噪声。

修法与 `paths.js` 对状态文件的做法一致：读取端保持默认位置、写入端可覆盖。
**已修**（提交 `b5acf75`）：`lib/paths.js` 新增 `logsDir()`（默认仍是 `<ROOT>/logs`，
历史日志不动；可由 `LOGS_DIR` 覆盖），上述 7 处写入/读取全部改走它，
`retention.pruneAtStartup()` 同步改；`isolation-guard` 自动设置并校验 `LOGS_DIR`，
10 个测试文件全部接入护栏。验证：整轮 `npm test` 后真实
`logs/2026-10-14/{crash,traffic}.jsonl` 字节数完全未变（18277 / 237819）。

