# 仓库规范化记录 · 2026-10-22

> 本轮对文档、脚本、目录结构与冗余文件做了一次系统性整理。本文是**完整变更台账**：
> 每个被移动的文件都能查到新位置，每个被删除的文件都能查到理由。
>
> 变更范围：`docs/`、`scripts/`、仓库根、`.gitignore`、`package.json`、引用路径修正。
> **未改动**：`src/` 与 `web/src/` 的业务逻辑（仅修正注释里的文档/脚本路径），
> 运行数据目录 `output/`、`logs/<日期>/`、`backups/*.json`。

---

## 0. 整理前后对比

| 项 | 整理前 | 整理后 |
|---|---|---|
| 仓库根目录条目 | 26 项（含 `_session_analysis`、`session-content`、`.history`、`preview`、`.trae-api`） | 21 项，仅保留源码 / 文档 / 脚本 / 配置 / 运行数据目录 |
| `docs/` | 38 个 md 平铺 + 4 个杂项目录，且**被 `.gitignore` 忽略**（只有 3 个文件被强制入库） | 6 个分类目录 + 索引 `docs/README.md`，全部入库 |
| `scripts/` | 53 个文件平铺 | `ops/ verify/ inspect/ probes/` 四类 + `scripts/README.md` |
| 重复文档 | `wb-ecosystem-comparison-2026-10-04 (2).md` 与正本逐字节相同（37737 B） | 删除副本 |
| 重复会话转储 | `_session_analysis/` 与 `session-content/` 各 10.3 MB，SHA-256 完全相同 | 均已删除（可从 `HEAD` 恢复，见 §4） |
| 磁盘占用 | — | **释放约 124 MB** |
| git 索引 | 4 个已删除文件仍被跟踪（`CHANGELOG.md` 等） | 已修正；`CHANGELOG.md` 已恢复 |

---

## 1. 文档迁移台账（`docs/`）

### 1.1 重命名 + 归类

| 原路径 | 新路径 |
|---|---|
| `docs/known-limitations.md` | `docs/01-architecture/known-limitations.md` |
| `docs/token-credit-metering.md` | `docs/01-architecture/token-credit-metering.md` |
| `docs/channel-onboarding.md` | `docs/02-technical/channel-onboarding.md` |
| `docs/key-management.md` | `docs/02-technical/key-management.md` |
| `docs/model-router-autotier.md` | `docs/02-technical/model-router-autotier.md` |
| `docs/workbuddy-at-rest-crypto.md` | `docs/02-technical/workbuddy-at-rest-crypto.md` |
| `docs/qoder-integration-guide.md` | `docs/02-technical/channels/qoder-integration-guide.md` |
| `docs/qoder-integration-analysis.md` | `docs/02-technical/channels/qoder-integration-analysis.md` |
| `docs/qoder-integration-analysis-v2.md` | `docs/02-technical/channels/qoder-integration-analysis-v2.md` |
| `docs/raccoon-integration.md` | `docs/02-technical/channels/raccoon-integration.md` |
| `docs/zcode-integration.md` | `docs/02-technical/channels/zcode-integration.md` |
| `docs/upgrade-plan-2026-10-04.md` | `docs/03-development/upgrade-plan-2026-10-04.md` |
| `docs/relaygate-frontend-refactor-plan.md` | `docs/03-development/frontend-refactor-plan.md` |
| `docs/REMEDIATION-PLAN.md` | `docs/03-development/remediation-plan.md` |
| `docs/code-review-2026-10-22.md` | `docs/04-reviews/code-review-2026-10-22.md` |
| `docs/ui-review-2026-10-04.md` | `docs/04-reviews/ui-review-2026-10-04.md` |
| `docs/razor/frontend-existence-audit-2026-10-15.md` | `docs/04-reviews/frontend-existence-audit-2026-10-15.md` |
| `docs/incident-2026-10-14-测试污染真实库.md` | `docs/05-incidents/incident-2026-10-14-test-db-pollution.md` |
| `docs/workbuddy-channel-detection-2026-10-21.md` | `docs/05-incidents/workbuddy-channel-detection-2026-10-21.md` |
| `docs/raccoon-capture-2026-10-15.md` | `docs/05-incidents/raccoon-capture-2026-10-15.md` |
| `docs/raccoon-iam-confirm-2026-10-19.md` | `docs/05-incidents/raccoon-iam-confirm-2026-10-19.md` |
| `docs/raccoon-qr-login-repair-2026-10-18.md` | `docs/05-incidents/raccoon-qr-login-repair-2026-10-18.md` |
| `docs/raccoon-daily-grant-upstream-2026-10-20.md` | `docs/05-incidents/raccoon-daily-grant-upstream-2026-10-20.md` |
| `docs/raccoon-daily-grant-correction-2026-10-20.md` | `docs/05-incidents/raccoon-daily-grant-correction-2026-10-20.md` |
| `docs/wb-ecosystem-comparison-2026-10-04.md` | `docs/06-deliverables/comparisons/wb-ecosystem-comparison-2026-10-04.md` |
| `docs/wb-ecosystem-comparison-addendum-2026-10-04.md` | `docs/06-deliverables/comparisons/wb-ecosystem-comparison-addendum-2026-10-04.md` |
| `docs/WorkBuddy同类项目对比分析报告.md` | `docs/06-deliverables/comparisons/workbuddy-comparison-report.md` |
| `docs/our-free-model-对比分析.md` | `docs/06-deliverables/comparisons/free-model-comparison.md` |
| `docs/dsh-ofm-深入对标与择优优化报告.md` | `docs/06-deliverables/benchmarks/dsh-ofm-benchmark-report.md` |
| `docs/dsh-ofm-四组功能代码级对标.md` | `docs/06-deliverables/benchmarks/dsh-ofm-code-level-comparison.md` |
| `docs/账号调度与积分消耗分析报告-2026-10-12.md` | `docs/06-deliverables/analysis/account-scheduling-credit-analysis-2026-10-12.md` |
| `docs/model-parameters-report-2026-10-06.md` | `docs/06-deliverables/analysis/model-parameters-report-2026-10-06.md` |

### 1.2 整目录迁移

| 原路径 | 新路径 | 说明 |
|---|---|---|
| `docs/review/`（7 文件） | `docs/04-reviews/code-review-2026-10-05/` | 首轮逐文件审查批次，内部相对链接保持有效 |
| `docs/audits/2026-10-10-product-professor-review/`（25 文件） | `docs/04-reviews/product-audit-2026-10-10/` | 产品审计批次，内部 `issues/` 相对链接保持有效 |
| `docs/预览-批1前端/`（4 png） | `docs/06-deliverables/previews/` | 界面预览截图 |
| `preview/v5-preview.html` | `docs/06-deliverables/previews/v5-preview.html` | v5 前端原型，属交付成果，移出入库 |

### 1.3 文档删除

| 文件 | 理由 |
|---|---|
| `docs/wb-ecosystem-comparison-2026-10-04 (2).md` | 与正本 SHA-256 完全相同的下载副本（浏览器重名后缀） |

### 1.4 新增文档

| 文件 | 用途 |
|---|---|
| `docs/README.md` | **文档索引与分类约定**，docs 的唯一入口 |
| `docs/01-architecture/system-overview.md` | 系统架构总览（分层、请求链路、数据落盘、任务、质量门） |
| `docs/03-development/repo-normalization-2026-10-22.md` | 本文（变更台账） |
| `scripts/README.md` | 脚本索引（分类、入口映射、真实上游风险提示） |

---

## 2. 脚本迁移台账（`scripts/`）

| 原路径 | 新路径 |
|---|---|
| `scripts/login-key.js` | **保持原位**（面板文案与 `src/routes/api-keys.js` 直接引用该路径） |
| `scripts/migrate-accounts-from-old.js` | `scripts/ops/migrate-accounts-from-old.js` |
| `scripts/export-qoder-token.js` | `scripts/ops/export-qoder-token.js` |
| `scripts/zcode-import-local.js` | `scripts/ops/zcode-import-local.js` |
| `scripts/zcode-fix-credit-pollution.js` | `scripts/ops/zcode-fix-credit-pollution.js` |
| `scripts/kill-orphan-node.ps1` | `scripts/ops/kill-orphan-node.ps1` |
| `scripts/verify-store-encryption.js` | `scripts/verify/verify-store-encryption.js` |
| `scripts/verify-review-fixes.js` | `scripts/verify/verify-review-fixes.js` |
| `scripts/verify-raccoon-live.js` | `scripts/verify/verify-raccoon-live.js` |
| `scripts/test-qoder-integration.js` | `scripts/verify/test-qoder-integration.js` |
| `scripts/verify-qoder-*.js`（10 个） | `scripts/verify/qoder/verify-qoder-*.js` |
| `scripts/parse-qoder-asar.js`、`parse-qoder-cn-asar.js`、`parse-raccoon-asar.js` | `scripts/inspect/` |
| `scripts/extract-qoder-asar.js`、`extract-qoder-code.js`、`extract-qoder-cn-asar.js`、`extract-qoder-cn-code.js`、`extract-raccoon-asar.js`、`list-qoder-main.js` | `scripts/inspect/` |
| `scripts/capture_raccoon.py`、`probe-raccoon-api.js` | `scripts/probes/` |
| `scripts/zcode-credit-impact.js`、`zcode-e2e.js`、`zcode-probe-now.js`、`zcode-verify-credit-isolation.js` | `scripts/probes/` |
| `scripts/probes/*`（原有 15 文件） | 保持原位 |
| `scripts/__pycache__/` | **删除**（Python 抓包脚本运行残留） |

### 2.1 随之修正的路径引用

| 文件 | 修正内容 |
|---|---|
| `package.json` | `verify:store`、`verify:review-fixes` 指向新路径 |
| `scripts/ops/zcode-*.js`、`scripts/probes/zcode-*.js`、`scripts/verify/{test-qoder-integration,verify-raccoon-live,verify-review-fixes}.js` | `require('../src/...')` → `require('../../src/...')` |
| `scripts/verify/verify-review-fixes.js` | `path.join(__dirname,'..','src',...)` → `'..','..','src'` |
| `scripts/verify/verify-store-encryption.js` | `path.resolve(__dirname,'..')` → `'..','..'`（ROOT 解析） |
| `scripts/verify/qoder/verify-qoder-realm-diff.js` | 输出路径 `logs/` 的 `__dirname` 层级 +1 |
| `scripts/probes/probe-raccoon-api.js` | 输出路径 `logs/` 的 `__dirname` 层级 +1 |
| `src/` 9 个文件、`web/src` 2 个文件 | 注释里的 `docs/...`、`scripts/...` 路径改为新位置（**仅注释，无逻辑改动**） |
| `README.md`、`docs/**` 20 个文件 | 交叉引用与相对链接重定向 |

---

## 3. 冗余文件清理台账

### 3.1 会话与工具残留（根目录）

| 路径 | 大小 | 理由 |
|---|---|---|
| `_session_analysis/session.v4.jsonl` | 10.3 MB | AI 会话转储，与 `session-content/` 逐字节相同 |
| `session-content/session.v4.jsonl` | 10.3 MB | 同上；会话记录属工具产物，非项目文档 |
| `.history/`（34 文件） | 0.5 MB | 编辑器 Local History 插件残留 |
| `.trae-api/`（根） | 空 | 状态目录已统一到 `output/.trae-api/` |
| `preview/_py.err`、`preview/_py.out` | 2.5 KB | `python -m http.server` 的访问日志 |
| `backups/web-src-before-v4-20261002-235211/` | 0.3 MB | v4 重构前的手工快照，代码已在 git 历史中 |
| `backups/_test-artifacts-20261014/` | 4.2 MB | 测试污染事故留下的测试产物（见 `05-incidents/incident-2026-10-14-test-db-pollution.md`） |

### 3.2 前端调试产物

| 路径 | 大小 | 理由 |
|---|---|---|
| `web/dev.err.log`、`web/dev.out.log` | 12 KB | `npm run dev` 输出，已在 `web/.gitignore` 声明忽略 |
| `web/_dev_v4.out` | 16 KB | v4 联调输出 |
| `web/tsconfig.tsbuildinfo` | 2 KB | tsc 增量缓存 |
| `web/.playwright-cli/`（60 文件） | 0.7 MB | Playwright CLI 会话录制 |

### 3.3 运行数据目录内的调试残留

| 路径 | 大小 | 理由 |
|---|---|---|
| `output/output/`（嵌套状态目录） | 0.1 MB | 从错误 cwd 启动产生的嵌套副本，非当前工作区 |
| `output/backend.out.log`、`backend.err.log` | <1 KB | 2026-09-13 的旧启动输出 |
| `output/compare-shots/`、`output/verify-shots/`（9 png） | 0.8 MB | 视觉核对截图，结论已进审查报告 |
| `output/overview-dashboard-final.png` | 0.1 MB | 同上 |
| `output/cmt-inventory.csv` | 8 KB | 一次性代码度量导出 |

> 保留：`output/.trae-api/`（凭据库与密钥）、`output/model-router.json`（路由运行态）、`output/logs/`。

### 3.4 `logs/` 内的逆向与探针残留（保留活日志与按日流量日志）

| 路径 | 大小 | 理由 |
|---|---|---|
| `logs/raccoon-extracted/` | 58.2 MB | Raccoon 客户端 asar 解包产物，可用 `scripts/inspect/` 重生成 |
| `logs/wb-extract/` | 37.9 MB | WorkBuddy 客户端 asar 解包产物，同上 |
| `logs/probe-*.out.log`（43 个） | 60 KB | 2026-09 的探针输出 |
| `logs/qoder-asar-files.txt`、`qoder-asar-summary.txt`、`qoder-cn-asar-summary.txt`、`qoder-main-files.txt`、`qoder-realm-diff.md` | 0.3 MB | 逆向分析中间产物，结论已进 `02-technical/channels/` |
| `logs/raccoon-api-probe.json`、`raccoon-capture.jsonl` | 55 KB | 抓包原始数据，结论已进 `05-incidents/raccoon-capture-2026-10-15.md` |
| `logs/wb-chat-hdr.txt`、`wb-headers-block*.txt`、`wb-vlm-block.txt` | 35 KB | 抓包头取样，结论已进 `05-incidents/workbuddy-channel-detection-2026-10-21.md` |
| `logs/upstream-*.json`、`upstream-*-sse.txt`、`get_detail_param.json`、`server.err.log`、`server.out.log` | 0.3 MB | 上游响应取样与旧启动日志 |

> 保留：`logs/<YYYY-MM-DD>/`（traffic / audit / crash 日志，面板统计在读）、
> `logs/relay.out.log`、`logs/relay.err.log`（`start.bat` 的服务输出，运行中）。

**合计释放约 124 MB。**

### 3.5 顺带修掉的引用缺陷

| 位置 | 问题 | 处理 |
|---|---|---|
| `docs/**/*.md`（24 个文件） | 383 处 Markdown 链接写成仓库根相对形式（`src/...`、`web/...`），在 GitHub 上全部断链 | 批量转为文件相对路径（`../../src/...`）；目标在仓库根不存在的（`docs/compare/*`、`docs/issue-30-heatmap.md` 等外部项目引用）保持原样 |
| `docs/04-reviews/product-audit-2026-10-10/ISSUE_INDEX.md` | 16 条 issue 链接指向同目录，实际文件在 `issues/` | 加 `issues/` 前缀 |
| `docs/04-reviews/product-audit-2026-10-10/AUDIT_REPORT.md` | 链接 `P3-003-test-coverage-gap.md`，文件实际是 `P3-002` | 改为 `P3-002` |
| `docs/06-deliverables/comparisons/wb-ecosystem-comparison-2026-10-04.md` | 6 张 `assets/*.png` 图片引用，该目录从未入库 | 移除图片引用、加说明，文件名清单保留在 §8 |
| `scripts/probes/README.md` | 指向旧文档路径 | 改为 `../../docs/05-incidents/workbuddy-channel-detection-2026-10-21.md` |
| `docs/06-deliverables/benchmarks/dsh-ofm-benchmark-report.md` | 脚本路径少一层（`scripts/probe-wb-pack-fields.js`） | 补成 `scripts/probes/...` |
| `src/upstream/client.js`、`src/upstream/errors.js` | 引用从未存在的 `docs/TRADEWORK-ASSISTANT-COMPARISON.md` | 改指 `docs/06-deliverables/comparisons/workbuddy-comparison-report.md` 的实际小节 |

> `.history/`（编辑器 Local History）会在删除后由 IDE 插件自动重建，已加入 `.gitignore`，
> 属于本机工具目录，不参与版本库。

---

## 4. 可恢复性

| 内容 | 恢复方式 |
|---|---|
| 任何被移动/删除的**已跟踪**文件 | `git log --follow <新路径>` 或 `git show <旧commit>:<旧路径>` |
| `_session_analysis/`、`session-content/` | `git show e6ead9d:session-content/session.v4.jsonl > session.v4.jsonl`（内容相同，只需恢复一份） |
| `CHANGELOG.md` | 本轮已从 `HEAD` 恢复回工作区（此前被误删） |
| asar 解包产物 | `node scripts/inspect/extract-*.js` 重新生成 |
| 探针输出 | `node scripts/probes/probe-*.js` 重新运行（部分会打真实上游） |
| 测试/调试截图 | 无法恢复（无 git 记录），结论已固化在审查报告中 |

---

## 5. 本轮未做的事（明确边界）

1. **未改业务代码**：`src/`/`web/src/` 的改动全部在注释里，逻辑零变更。
2. **未动运行数据**：`output/`（凭据库、密钥、路由运行态）、`logs/<日期>/`、`backups/*.json` 原样保留。
3. **未合并两套日志目录**：`logs/` 是运行期日志根（`LOGS_DIR` 可覆盖），`output/logs/` 是早期部署遗留，
   迁移需改 `paths.js` 默认值并照顾历史日志回读，属行为变更，留待下次单独处理。
4. **未修复历史断链**：`comparisons/wb-ecosystem-comparison-2026-10-04.md` 引用的 `assets/*.png` 从未入库，
   已在 `docs/README.md` 的「已知缺口」登记。
5. **未重命名 `docs/04-reviews/code-review-2026-10-05/` 内的中文文件名**：该目录是历史批次快照，
   整体搬迁保持内部链接有效比逐个改名更安全。
