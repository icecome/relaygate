# scripts/ 脚本索引

> 本目录的脚本**不是**运行链路的组成部分，全部是运维工具、验证脚本与取证探针。
> 生产链路只依赖 `src/`，删掉整个 `scripts/` 不影响服务运行。
>
> 最后整理：2026-10-22。新增脚本请按下面的四类归位，并在本文件登记。

---

## 分类与选取原则

| 目录 | 定位 | 是否需要长期保留 |
|---|---|---|
| `ops/` | 运维与一次性修复工具（迁移、轮换、密钥救援） | 是 |
| `verify/` | 可复跑的验证脚本（回归、体检、集成测试） | 是 |
| `inspect/` | 客户端安装包（asar）反查工具，只读 | 是（客户端升级后复用） |
| `probes/` | 上游协议探针，一次性取证，会打真实上游 | 结论进 `docs/05-incidents/` 后可删 |
| `login-key.js` | 登录密钥 CLI，保持原位 | 是（面板文案直接引用该路径） |

`npm run` 里挂的入口（改动这些文件需同步 `package.json`）：

| npm 脚本 | 实际文件 |
|---|---|
| `npm run verify:store` | `verify/verify-store-encryption.js` |
| `npm run verify:review-fixes` | `verify/verify-review-fixes.js` |
| `npm run verify:wb-channel` | `probes/verify-wb-channel.js` |
| `npm run probe:wb-packs` | `probes/probe-wb-pack-fields.js` |
| `npm run probe:wb-request` | `probes/dump-wb-request.js` |
| `npm run probe:wb-e2e` | `probes/e2e-wb-11128.js` |

---

## ops/ — 运维与修复

| 脚本 | 用途 |
|---|---|
| `migrate-accounts-from-old.js` | 从旧项目 `my-trae-api` 迁移账号到 RelayGate |
| `export-qoder-token.js` | 在装有 Qoder 客户端的机器上导出 token 供跨机导入 |
| `zcode-import-local.js` | 从本机 ZCode 客户端导入凭据（写真实账号库） |
| `zcode-fix-credit-pollution.js` | 一次性修复：清除 ZCode 写入积分口径的历史污染（`--apply` 才落盘） |
| `kill-orphan-node.ps1` | 结束占用网关端口的孤儿 node 进程（srvany 停止服务时只杀 cmd 包装） |

## verify/ — 可复跑验证

| 脚本 | 用途 | 是否打真实上游 |
|---|---|---|
| `verify-store-encryption.js` | 凭据库加密一致性体检（只读） | 否 |
| `verify-review-fixes.js` | 审查发现项的回归验证（mock 上游） | 否 |
| `verify-raccoon-live.js` | Raccoon 运营面端到端验证（`--chat` 会消耗少量积分） | 是 |
| `test-qoder-integration.js` | Qoder 集成测试（真实上游 + 真实本机客户端） | 是 |
| `qoder/verify-qoder-credential-read.js` | 验证 Qoder 凭据可解密（os_crypt v10 + DPAPI） | 否 |
| `qoder/verify-qoder-checkin.js` | Qoder 每日积分查询端点 | 是 |
| `qoder/verify-qoder-chat-endpoint.js` | Qoder 新版 chat 端点（纯 Bearer，OpenAI 兼容） | 是 |
| `qoder/verify-qoder-catalog-diff.js` | 国内版 / 国际版模型目录对比 | 是 |
| `qoder/verify-qoder-dual-realm.js` | 双区域凭据解密 + 端点验证 | 是 |
| `qoder/verify-qoder-realm-diff.js` | 双区域差异全量对比（输出 `logs/qoder-realm-diff.md`） | 是 |
| `qoder/verify-qoder-cn-chat.js` | 国内版对话端点（老版 COSY 协议） | 是 |
| `qoder/verify-qoder-cn-checkin.js` | 国内版积分活动查询与领取 | 是 |
| `qoder/verify-qoder-cn-cosy.js` | 国内版 COSY 协议连通性 | 是 |
| `qoder/verify-qoder-cn-idempotent.js` | 重复 claim 的幂等性验证 | 是 |

## inspect/ — 客户端安装包反查（只读）

| 脚本 | 用途 |
|---|---|
| `parse-qoder-asar.js` / `parse-qoder-cn-asar.js` | 解析 asar 头（零依赖，不装 `@electron/asar`） |
| `extract-qoder-asar.js` / `extract-qoder-cn-asar.js` | 抽取 asar 内指定文件 |
| `extract-qoder-code.js` / `extract-qoder-cn-code.js` | 抽取 `out/` 下全部 `.js`/`.json` 供离线检索 |
| `list-qoder-main.js` | 列出 asar 头部条目 |
| `parse-raccoon-asar.js` / `extract-raccoon-asar.js` | 同理，针对 Raccoon 客户端 |

> 这些脚本里的**客户端安装路径是硬编码的**（`C:\opt\workstations\agents\...`），
> 换机器需先改路径。

## probes/ — 上游协议探针（一次性取证）

| 脚本 | 用途 |
|---|---|
| `probe-wb-channel.js` | WorkBuddy 渠道校验 `11128` 的多变体探测（结论见 `docs/05-incidents/workbuddy-channel-detection-2026-10-21.md`） |
| `probe-wb-trigger.js` | 反向定位：缺哪一处会触发 `11128` |
| `probe-wb-body.js` / `probe-wb-size.js` / `probe-wb-huge.js` | 请求体维度（形状 / 体量 / >1MB）探测 |
| `probe-wb-matrix.js` / `probe-wb-origin.js` | 模型 × 头集矩阵、接入域名维度 |
| `probe-wb-burst.js` | 是否为突发风控的验证 |
| `probe-wb-accounts.js` | 用网关真实代码路径逐账号打一次 chat |
| `probe-wb-catalog.js` | 目录端点在新旧头集下是否可用 |
| `probe-wb-pack-fields.js` | 额度包响应的时间字段（只读） |
| `verify-wb-channel.js` / `verify-wb-failover.js` | 渠道身份回归、`11128` 降级行为（mock，本地） |
| `dump-wb-request.js` / `e2e-wb-11128.js` | 抓网关自己发出的请求 / 端到端复现 `11128` |
| `wb-asar.js` | WorkBuddy `app.asar` 只读探针（list / cat / dump / grep） |
| `probe-raccoon-api.js` / `capture_raccoon.py` | Raccoon 运营面请求复放 / mitmproxy 抓包 addon |
| `zcode-probe-now.js` / `zcode-credit-impact.js` / `zcode-verify-credit-isolation.js` / `zcode-e2e.js` | ZCode 套餐探测、积分口径影响分析、口径隔离回归、端到端 |

### 探针的运行约定

1. **产物写 `logs/`，不写 `docs/`**：结论沉淀成文档后再进 `docs/05-incidents/`。
2. **默认只读**；会消耗真实积分或写真实库的脚本在文件头都有 ⚠️ 标注，运行前先看头部注释。
3. 探针产物（`logs/probe-*.out.log`、`logs/*-extract/`）已在 `.gitignore` 中忽略，
   且已在本轮整理中清空过一次，可随时重跑重生成。

---

## 本轮的目录变更

原 `scripts/` 是 53 个文件平铺的混合目录。本轮按用途分到 `ops/ verify/ inspect/ probes/`，
并修正了因目录下移导致的相对路径（`require('../src/...')` → `require('../../src/...')`、
`__dirname` 拼接层级、`verify-store-encryption.js` 的 `ROOT` 解析）。
完整清单见 [../docs/03-development/repo-normalization-2026-10-22.md](../docs/03-development/repo-normalization-2026-10-22.md)。
