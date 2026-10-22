# RelayGate 文档索引

> 本文件是 `docs/` 的**唯一入口**。任何文档新增、迁移、废弃都必须同步更新本索引。
> 最后整理：2026-10-22（详见 [repo-normalization-2026-10-22.md](03-development/repo-normalization-2026-10-22.md)）

---

## 1. 分类体系

文档按「软件开发生命周期的产出类型」分为六类，编号即阅读顺序：

| 编号 | 目录 | 定位 | 什么时候看 |
|---|---|---|---|
| 01 | [`01-architecture/`](01-architecture/) | 架构与边界：系统怎么分层、数据怎么流、哪些是明确取舍 | 接手项目、改跨模块逻辑、评估能否做某事 |
| 02 | [`02-technical/`](02-technical/) | 技术方案：渠道接入、密钥、路由、加密的具体做法 | 实现某个渠道/功能前 |
| 03 | [`03-development/`](03-development/) | 开发进展：计划、路线图、整改方案、变更记录 | 排期、追溯「为什么这么改」 |
| 04 | [`04-reviews/`](04-reviews/) | 审查与审计：代码审查、UI 审查、产品审计、存在性裁决 | 动手改代码前查有没有已裁决过 |
| 05 | [`05-incidents/`](05-incidents/) | 问题记录：事故复盘、上游风控变化、取证结论 | 遇到同类报错、怀疑上游行为变化 |
| 06 | [`06-deliverables/`](06-deliverables/) | 交付成果：对标报告、分析报告、界面预览 | 汇报、找依据、看历史结论 |

**根目录另有：**
- [`../README.md`](../README.md) — 面向使用者的安装/启动/配置说明
- [`../CHANGELOG.md`](../CHANGELOG.md) — 面向使用者的版本变更日志
- [`../.env.example`](../.env.example) — 全部环境变量（每个都有注释）

---

## 2. 01-architecture — 架构与边界

| 文档 | 内容 | 状态 |
|---|---|---|
| [system-overview.md](01-architecture/system-overview.md) | 分层结构、请求链路、数据落盘位置、模块职责与依赖方向 | 现行 |
| [known-limitations.md](01-architecture/known-limitations.md) | 全部已知限制与显式取舍（安全边界、多进程、Windows 服务形态等），每条都写了接受理由 | 现行 |
| [token-credit-metering.md](01-architecture/token-credit-metering.md) | Token / 积分 / 额度的计量口径，以及三套口径为何不能相加 | 现行 |

## 3. 02-technical — 技术方案

| 文档 | 内容 | 状态 |
|---|---|---|
| [channel-onboarding.md](02-technical/channel-onboarding.md) | 新增一个上游渠道的标准步骤（变体表 → 凭据 → 签到 → 转发 → 测试） | 现行 |
| [key-management.md](02-technical/key-management.md) | 登录密钥 / 访问密钥 / 凭据加密密钥三类密钥的职责与轮换 | 现行 |
| [model-router-autotier.md](02-technical/model-router-autotier.md) | 虚拟模型解析、候选池、健康度与自动分层 | 现行 |
| [workbuddy-at-rest-crypto.md](02-technical/workbuddy-at-rest-crypto.md) | WorkBuddy 本地凭据的加密格式与解 envelope 方法 | 现行 |

### 渠道方案（`02-technical/channels/`）

| 文档 | 渠道 | 状态 |
|---|---|---|
| [zcode-integration.md](02-technical/channels/zcode-integration.md) | ZCode（限时套餐探测与领取，运营面） | 现行 |
| [raccoon-integration.md](02-technical/channels/raccoon-integration.md) | Raccoon / 商汤小浣熊（扫码登录、积分、转发） | 现行 |
| [qoder-integration-guide.md](02-technical/channels/qoder-integration-guide.md) | Qoder（实施与运维：双区域凭据、每日积分、目录、对话面） | 现行 |
| [qoder-integration-analysis-v2.md](02-technical/channels/qoder-integration-analysis-v2.md) | Qoder 协议与实证分析 v2/v3（含国内外差异附录） | 现行 |
| [qoder-integration-analysis.md](02-technical/channels/qoder-integration-analysis.md) | Qoder 分析 v1 | **已被 v2 取代**，仅留档 |
| [../02-technical/channel-onboarding.md](02-technical/channel-onboarding.md) | Trae / WorkBuddy 基线渠道的接入约定 | 现行 |

## 4. 03-development — 开发进展

| 文档 | 内容 | 状态 |
|---|---|---|
| [upgrade-plan-2026-10-04.md](03-development/upgrade-plan-2026-10-04.md) | 从 v3.0 起的升级路线与取舍 | 历史（大部分已落地） |
| [frontend-refactor-plan.md](03-development/frontend-refactor-plan.md) | 管理端从单页迁到 Vite + React 的结构方案 | 已落地 |
| [remediation-plan.md](03-development/remediation-plan.md) | 汇总两轮审查 87 项发现的整改总方案（4 条 P0 主线 / 7 个工作段） | 执行中 |
| [repo-normalization-2026-10-22.md](03-development/repo-normalization-2026-10-22.md) | 本次文档与目录规范化：完整迁移/删除清单 | 现行 |

## 5. 04-reviews — 审查与审计

| 文档 | 范围 | 时间 |
|---|---|---|
| [code-review-2026-10-22.md](04-reviews/code-review-2026-10-22.md) | 最新一轮代码审查（凭据泄漏、幂等、续期判据等） | 2026-10-22 |
| [ui-review-2026-10-04.md](04-reviews/ui-review-2026-10-04.md) | 管理端视觉与交互审查（含 v5 预览检查单） | 2026-10-04 |
| [frontend-existence-audit-2026-10-15.md](04-reviews/frontend-existence-audit-2026-10-15.md) | 前端 31 个概念的存在性裁决（奥卡姆剃刀） | 2026-10-15 |
| [code-review-2026-10-05/](04-reviews/code-review-2026-10-05/) | 首轮逐文件审查 6 份 + 修复验证报告（入口见该目录 README） | 2026-10-05 |
| [product-audit-2026-10-10/](04-reviews/product-audit-2026-10-10/) | Product Professor 全面审计：8 份专项报告 + 16 个 issue（入口 `AUDIT_REPORT.md` / `ISSUE_INDEX.md`） | 2026-10-10 |

## 6. 05-incidents — 问题记录与错误追踪

| 文档 | 事件 | 结论 |
|---|---|---|
| [incident-2026-10-14-test-db-pollution.md](05-incidents/incident-2026-10-14-test-db-pollution.md) | 测试写进真实状态目录，污染生产库 | 已修复：测试强制隔离状态目录 |
| [workbuddy-channel-detection-2026-10-21.md](05-incidents/workbuddy-channel-detection-2026-10-21.md) | WorkBuddy 上游渠道校验 `11128` 的定位与重建客户端身份 | 已修复：头形态按官方客户端重建 |
| [raccoon-capture-2026-10-15.md](05-incidents/raccoon-capture-2026-10-15.md) | Raccoon 抓包取证，修正早期错误结论 | 结论已落地 |
| [raccoon-iam-confirm-2026-10-19.md](05-incidents/raccoon-iam-confirm-2026-10-19.md) | 新 IAM 登录链路确认 | 结论已落地 |
| [raccoon-qr-login-repair-2026-10-18.md](05-incidents/raccoon-qr-login-repair-2026-10-18.md) | 扫码登录失败排查 | 已修复 |
| [raccoon-daily-grant-upstream-2026-10-20.md](05-incidents/raccoon-daily-grant-upstream-2026-10-20.md) | 每日积分发放的上游行为变化 | 已适配 |
| [raccoon-daily-grant-correction-2026-10-20.md](05-incidents/raccoon-daily-grant-correction-2026-10-20.md) | 上述变化的二次勘误 | 已适配 |

## 7. 06-deliverables — 交付成果

| 目录 | 内容 |
|---|---|
| [comparisons/](06-deliverables/comparisons/) | 同类项目对比：WorkBuddy 生态 4 家横向对比 + 勘误、WorkBuddy 同类项目对比报告、our-free-model 对比分析 |
| [benchmarks/](06-deliverables/benchmarks/) | DSH 对标：深入对标与择优优化报告、四组功能代码级对标 |
| [analysis/](06-deliverables/analysis/) | 账号调度与积分消耗分析报告、模型参数实测报告 |
| [previews/](06-deliverables/previews/) | 管理端界面预览：v5 原型（`v5-preview.html`）+ 4 张图表截图 |

> ⚠️ `comparisons/wb-ecosystem-comparison-2026-10-04.md` 正文引用的 `assets/*.png` 截图**从未入库**（原 `docs/compare/assets/` 不存在），
> 引用图片为历史遗留断链，不影响文字结论。增补报告的勘误说明已记录此事。

---

## 8. 命名与归档约定

1. **目录用 ASCII + 两位编号**，编号只表示阅读顺序，不表示优先级。
2. **文件名用小写 ASCII slug**；带时间属性的文档以 `-YYYY-MM-DD` 结尾（事故、审查、报告）。
   历史文档中的中文文件名已在本轮规范化为 slug，旧名与新名对照见 [repo-normalization-2026-10-22.md](03-development/repo-normalization-2026-10-22.md)。
3. **状态标记**三档：`现行`（照它做）、`历史`（已完成/已过时，仅留档）、`已被取代`（有更新的同名文档）。
4. **一次性产出不进 docs**：临时探针脚本放 `scripts/probes/`，探针输出留在 `logs/`（git 忽略），
   只有结论沉淀成文档才进 `docs/`。
5. **删除旧文档前先归档结论**：若结论已被代码实现，可在对应文档标注「已落地」而非删除。
6. **代码引用格式**：正文引用源码一律写 `文件:行号`（如 `src/routes/openai.js:163`），
   Markdown 链接一律用**文件相对路径**（`../` 起算），不要写 `src/...` 这种仓库根相对形式——
   后者在 GitHub 上会断。历史审查文档里的根相对链接已在 2026-10-22 批量转换为文件相对路径。

## 9. 已知缺口（TODO）

- [ ] `comparisons/wb-ecosystem-comparison-2026-10-04.md` 的 `assets/*.png` 截图缺失（需重新截图或删除引用）
- [ ] `05-incidents/` 尚无 Raccoon 之外渠道的事故记录模板，新增事故可复制现有文件结构
- [ ] `01-architecture/system-overview.md` 需随 `src/routes/` 端点变更同步维护
