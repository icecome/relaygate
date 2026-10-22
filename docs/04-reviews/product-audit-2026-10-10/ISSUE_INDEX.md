# ISSUE_INDEX — 全部 16 个 issue

**Product Professor · 2026-10-10 · commit `2a2ec43`**

| ID | 标题 | 优先级 | 类别 | 难度 | 风险 | 状态 |
|---|---|---|---|---|---|---|
| [P0-001](issues/P0-001-store-update-lost-update.md) | `store.update()` 读-改-写导致跨进程丢失更新 | 🔴 P0 | 架构/数据 | 中 | 中 | 待修 |
| [P0-002](issues/P0-002-no-graceful-shutdown.md) | 无优雅停机 + 定时任务无跨进程防重 | 🔴 P0 | 可靠性 | 中 | 低 | 待修 |
| [P1-001](issues/P1-001-overview-duplication.md) | Overview 重复凭据池表与运行状态 9 项 | 🟠 P1 | 产品清晰度 | 低 | 低 | 待修 |
| [P1-002](issues/P1-002-onboarding-dead-end.md) | 首登引导断裂，核心流程 4 次跳转无引导 | 🟠 P1 | UX | 中 | 低 | 待修 |
| [P1-003](issues/P1-003-empty-and-error-states.md) | 19/20 空状态无指引，30+ 错误无下一步 | 🟠 P1 | UX/文案 | 中 | 极低 | 待修 |
| [P1-004](issues/P1-004-oauth-listener-injection.md) | OAuth 本地监听器凭据注入面 | 🟠 P1 | 安全 | 低-中 | 低 | 待修 |
| [P1-005](issues/P1-005-docs-as-ui-copy.md) | 论文体脚注、内部代号泄漏、caveat 重复 4 次 | 🟠 P1 | 文案 | 低 | 极低 | 待修 |
| [P1-006](issues/P1-006-css-fossil-and-undefined-vars.md) | 三处 CSS 引用不存在的东西 + tailwind 化石 | 🟠 P1 | 设计系统 | 极低 | 极低 | 待修 |
| [P1-007](issues/P1-007-mobile-unusable.md) | 移动端零断点，390px 主区仅 174px | 🟠 P1 | UX/响应式 | 中 | 中 | 待修 |
| [P1-008](issues/P1-008-unlimited-default-ratelimit.md) | 转发面默认无限流 | 🟠 P1 | 安全 | 极低 | 极低 | 待修 |
| [P2-001](issues/P2-001-growth-center-scope-creep.md) | 成长中心 scope creep（含抽奖按钮） | 🟡 P2 | 产品定位 | 低 | **中（需先确认是否真需求）** | 待确认 |
| [P2-002](issues/P2-002-ghost-config.md) | `model-fallback.json` 无消费者 + 幽灵 env | 🟡 P2 | 配置 | 低 | 低 | 待修 |
| [P2-003](issues/P2-003-stream-error-as-text.md) | 流中途失败被渲染成模型输出文本 | 🟡 P2 | 协议正确性 | 低-中 | 中 | 待修 |
| [P2-004](issues/P2-004-no-protocol-adapter.md) | 四份手写协议骨架，已产生行为分叉 | 🟡 P2 | 架构 | 高 | **高（须在 P0/P1 稳定后进行）** | 延后 |
| [P3-001](issues/P3-001-silent-degraded-startup.md) | 启动链静默降级：DB 损坏 / key 丢失 / 假 health | ⚪ P3 | 可靠性 | 低-中 | 低 | 待修 |
| [P3-002](issues/P3-002-test-coverage-gap.md) | 三个转发路由零测试 + 前端零测试 + 无 CI | ⚪ P3 | 测试 | 中-高 | 低 | 待修 |

---

## 执行顺序建议

```
第 1 批（1 天，只改 UI，立刻提升信任感）
  P1-001 → P1-003 → P1-005 → P1-006
  （删重复 → 补状态 → 清文案 → 修 CSS 幽灵）

第 2 批（1 天，接通已有后端能力）
  P1-002 → P3-002 阶段 1（CI）
  （onboarding → 建立守门）

第 3 批（2 天，后端正确性）
  P0-001 → P0-002 → P1-008 → P1-004
  （丢失更新 → 优雅停机 → 限流 → OAuth 面）

第 4 批（2 天，产品取舍）
  P2-001（先确认是否真需求）→ P2-002 → P1-007（移动端）→ README/版本/changelog

第 5 批（2-3 天，独立进行）
  P2-003 → P3-002 阶段 2（协议测试）→ P2-004（协议适配层重构）
  P3-001（启动链）可与第 5 批并行
```

## 依赖关系

```
P2-003（流错误出口）─────┐
P3-002 阶段2（协议测试）──┼──→ P2-004（协议重构）才能安全进行
P0-001、P0-002 ──────────┘

P1-003（空状态组件化）──→ P1-002（onboarding 空状态复用同一组件）
```

## 未能单列 issue 但已记录在报告的观察项

| 观察项 | 位置 | 处置建议 |
|---|---|---|
| TrafficPage「按模型筛选」是死控件（后端不读 `model` 参数） | [TrafficPage.tsx:149-158](../../../web/src/features/stats/TrafficPage.tsx#L149-L158) + [admin-traffic.js](../../../src/routes/admin-traffic.js) | 删输入框或后端实现过滤；已并入 P1-003 的空状态清理 |
| 密钥「轮换」`graceMs:0` 与"宽限期"文案不符 | [AccessKeysPage.tsx:123,130](../../../web/src/features/accounts/AccessKeysPage.tsx#L123-L130) | 行为与文案二选一；建议并入 P1-003 的文案清理 |
| 凭据表「权益包」列取 `packs[0]`，与 PackDialog 的 FEFO 排序不同源 | [CredentialsPage.tsx:376-378](../../../web/src/features/accounts/CredentialsPage.tsx#L376-L378) | 统一用 `packsOf(a)[0]`；低优先 |
| `expirySummary`（账号数）vs 后端 `expiring3d/7d`（积分额度）同名不同义 | [accountPacks.tsx:120-133](../../../web/src/features/accounts/accountPacks.tsx#L120-L133) | 统一口径并改名；已并入 P1-005 的文案清理 |
| 前端复刻后端 FEFO / 轮转池排序 | [accountPacks.tsx:99-107](../../../web/src/features/accounts/accountPacks.tsx#L99-L107)、[ModelRouterPage.tsx:339-359](../../../web/src/features/models/ModelRouterPage.tsx#L339-L359) | 删显示侧镜像；并入 P2-004 重构 |
| `accountState` 逐字双实现 | [format.ts:6-13](../../../web/src/shared/lib/format.ts#L6-L13) vs [types.ts:120-124](../../../web/src/shared/api/types.ts#L120-L124) | 留一份；机械修复 |
| `KeyCards`/`KeyCardGroups`/`KeyValue` 三套键值渲染 | [shared/ui/index.tsx](../../../web/src/shared/ui/index.tsx) | 三选一；低优先 |
| 通知面板 secret 字段"不回显"是假的（值绑定真实明文，仅 type=password 遮挡） | [NotifyBackupPanel.tsx:441-447](../../../web/src/features/ops/NotifyBackupPanel.tsx#L441-L447) | 配合 P2-011（API 层脱敏）一起修 |
| 管理面板 aria/键盘可达性未系统审查 | 全局 | 本轮范围外，建议单独跑 `/product-professor ux` |
| `docs/wb-ecosystem-comparison-*.md` 完全重复文件 | [docs/](../../../docs) | 删一份；并入 P1-006 同批清理 |