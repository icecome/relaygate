# SCORECARD — RelayGate 管理面板
**Product Professor · 2026-10-10 · commit `2a2ec43`**

---

## 加权评分

| # | 类别 | 权重 | 得分 | 加权得分 | 一句话依据 |
|---|---|---:|---:|---:|---|
| 1 | Product clarity | 10% | **55** | 5.50 | 8 页无一把自己的职责做完；总览重复运行状态 9/9；"口径"成了信息架构的第一性分类 |
| 2 | Core functionality | 15% | **82** | 12.30 | 账号池/路由/统计/转发四条主线真的能跑，后端 288 断言全绿；扣分在无 onboarding 状态机 |
| 3 | UX and user flow | 15% | **38** | 5.70 | 19/20 空状态零指引、30+ 错误零下一步、12 个无解释 disabled、移动端不可用、死交互 |
| 4 | Visual polish | 10% | **58** | 5.80 | token 层有真实设计判断（字号阶梯/reduced-motion/表格溢出兜底）；但三处 CSS 引用不存在的东西 + tailwind 化石配置 |
| 5 | Architecture | 12% | **60** | 7.20 | 前端分层是真的；后端四份手写协议骨架 + 配置面 7 层无校验 + 前端复刻后端算法 |
| 6 | Security and privacy | 12% | **55** | 6.60 | CSP 严格、M-S5/M-S6 已修、npm 0 漏洞；但 OAuth 监听器注入面 + 默认无限流 + 无盐哈希 + 密钥与密文同目录 |
| 7 | Performance | 8% | **62** | 4.96 | 分包真实、请求去重与取消到位；转发热路径同步全表读 ×4、每请求 3 次同步 stat、流式无超时 |
| 8 | Reliability and tests | 8% | **52** | 4.16 | 288 断言广度高；但三个转发路由零 require、零 HTTP 测试、零前端测试、无优雅停机、假 health check |
| 9 | Feature completeness | 6% | **85** | 5.10 | 功能确实全（甚至过全）；缺 README/版本号/changelog/审计可见/手动触发 |
| 10 | Business / launch readiness | 4% | **30** | 1.20 | 无 README、无版本、无 changelog、成本数字自承不可信、配置有幽灵项 |
| | **合计** | **100%** | | **58.56** | |

---

## 总分

# **Product Professor Score: 54 / 100**

> 加权原始分 58.56。因存在 **2 个未解决 P0**（skill 硬规则：Overall ≤ 85，本项未触发约束）以及 UX 严重低于及格线对整体可信度的拉低，最终取整并下调至 **54**。
> 等级：**C**（"能做，但还不该交付给它的用户"）

| 派生指标 | 分数 | 含义 |
|---|---:|---|
| **Launch Readiness** | **42 / 100** | 能跑起来 ≠ 能理解 ≠ 能信任 ≠ 坏了能自救。四条只有第一条成立 |
| **True Score** | **45 / 100** | 一个非技术的普通人打开它，会不会认为这是个正规工具？——会犹豫 |
| **AI-Generated Feel Badness** | **6.5 / 10** | 不是空壳 demo，是"AI 深度参与且极其克制地生成了大量冗余" |
| **Expected User Complaint Severity** | **7.5 / 10** | 5 个角色里 4 个会给出 2-3 星并留下具体抱怨 |

---

## 分数是怎么来的（可复核）

### Category 2 — Core functionality = 82（本项目最高分）

支撑证据：
- `npm test` → 236 + 11 + 41 = **288 断言全绿**，exit 0
- 账号池真实调度：FEFO + 优先级 + 成本分层 + 余额门槛 + 模型级冷却（[pool.js:448-484](../../../src/credentials/pool.js#L448-L484)）
- 三条协议面真实接线，OpenAI/Anthropic/Codex 兼容
- 模型路由、目录同步、可用性探活、定价标定全部有真实实现
- 8 条 lazy 路由全部可达，无孤儿导航项

**为何不给 90+**：核心流程（首登 → 首次可用）需要 4 次页面跳转 + 2 个模态且无引导（P1-002）。

### Category 3 — UX and user flow = 38（本项目最低分）

这是把总分从 B 拉到 C 的决定性一栏。逐项：

| 判据 | 结果 | 证据 |
|---|---|---|
| 空状态有下一步 | **1 / 20** | 唯一正确：[OpsPage.tsx:1368](../../../web/src/features/ops/OpsPage.tsx#L1368) |
| 错误提示含"接下来做什么" | **0 / 30+** | 全库无一条 |
| disabled 按钮有解释 | **0 / 12** | [AccessKeysPage.tsx:263-272](../../../web/src/features/accounts/AccessKeysPage.tsx#L263-L272)、[ModelRouterPage.tsx:432](../../../web/src/features/models/ModelRouterPage.tsx#L432) 等 |
| 页面能一屏完成职责 | **0 / 8** | OpsPage 单页 1603 行 / 约 40 控件 |
| 移动端可用 | **否** | 390px 主区约 190px |
| 加载中不误导 | **否** | 4 张口径卡加载中显示 `0 credits`；账号池空数组渲染永久"加载中" |

### Category 6 — Security = 55（受 skill 硬规则约束）

auth 与 DB 权限已完整审查，故不受"≤75"上限约束。实际得分来自：

**加分**：CSP `script-src 'self'` 无 unsafe-inline；X-Frame-Options DENY + nosniff + Referrer-Policy；Bearer-header 鉴权天然免疫经典 CSRF；M-S5（平台密钥 resources ACL 绕过）与 M-S6（provider apiKey 明文）**均已修复且有回归测试**；`npm audit` 0 漏洞；已提交配置无明文密钥；`.env` 未入库；前端密钥存 sessionStorage 且从不进 URL。

**扣分**：OAuth 监听器注入面（P1-004）、转发面默认无限流（P1-008）、登录密钥无盐 SHA-256（P2-009）、密钥与密文同目录（P2-010）、webhook 密钥明文且 API 原样返回（S5）。

### Category 8 — Reliability = 52

288 断言是真实资产，但**覆盖的不是产品核心**：`routes/openai.js`、`routes/anthropic.js`、`routes/responses.js` 三个文件在测试中**一个 require 都没有**。加上无优雅停机（P0-002）与假 health check（P3-001），这一栏不可能及格。

---

## 评分硬上限检查（skill 强制规则）

| 规则 | 是否触发 | 说明 |
|---|---|---|
| build 失败 → Launch ≤ 80 | 未触发 | `npm run build` ✅ 通过（entry 195.84 kB / gzip 64.46 kB，15 chunk，1.15s） |
| 未审 auth/DB 权限 → Security ≤ 75 | 未触发 | 已完整审查；Security 55 远低于上限 |
| 未审移动端 → UX ≤ 80 | **触发** | 移动端为 CRITICAL 缺陷；UX 38，远低于上限 |
| 缺失空/错/加载态 → True ≤ 80 | **触发** | 三者均严重缺失；True 45 |
| 有未解决 P0 → Overall ≤ 85 | **触发** | 2 个 P0；Overall 54 |

---

## 与上一次审查的对比

仓库内已有 [docs/04-reviews/code-review-2026-10-05/05-综合审查报告-2026-10-05.md](../../../docs/04-reviews/code-review-2026-10-05/05-综合审查报告-2026-10-05.md)（SPEAR 62/100）与 [docs/04-reviews/frontend-existence-audit-2026-10-15.md](../../../docs/04-reviews/frontend-existence-audit-2026-10-15.md)。

| 维度 | 前次结论 | 本次结论 | 差异原因 |
|---|---|---|---|
| 安全 | 62/100，2 个 MAJOR | 本次独立复核：**2 个 MAJOR 均已修复并有回归测试** | 前次报告后已修复 |
| 依赖 | 3 项漏洞（1 high） | **0 漏洞** | 已 `npm audit fix` |
| 技术债 | 架构健康度 61/100 | 本次架构 60/100，一致 | 同一批问题仍在（协议骨架重复、配置面） |
| **UX / 产品** | 前次两轮均未评估 | **38/100，最低分** | **这是本次审计新增的视角，也是决定等级的一栏** |

**结论**：前两轮审查都在评"代码写得好不好"，答案一直是"还不错"。本次评的是"这东西该不该给用户用"，答案是"还不行"。**这正是 C 与 B 的分界。**

---

## 修复后的预期分数

| 做完 | 预期 Overall | 关键变化 |
|---|---|---|
| 第 1 批（1 天，只改 UI） | 62 | UX 38 → 52；True Score 45 → 58 |
| 第 2 批（1 天，接已有后端） | 68 | Product clarity 55 → 70；onboarding 闭环 |
| 第 3 批（2 天，后端正确性） | 74 | 2 个 P0 清零；Security 55 → 68 |
| 第 4 批（2 天，产品取舍 + 文档） | 80 | Launch 42 → 75；AI 感 6.5 → 4.0 |

**做到 80 分，这东西就是一个可以推荐给别人用的工具了。**

---

## 分数追踪

```
product-professor record-score --auto "After initial audit"
product-professor compare
```