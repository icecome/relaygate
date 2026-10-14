# 项目任务进度与现状解析

## 1. 项目目标与背景

**核心目标**: 在 RelayGate（多平台账号池网关）项目中接入 Qoder AI 编程客户端的支持，包括：
- 每日 10 点领取 100 Credits 积分奖励
- 支持有效期三十日的权益包管理
- 支持 Qwen3.8-Flash 模型限免使用

**项目背景**: 
- RelayGate 已支持 Trae、WorkBuddy、ZCode 三个平台
- 采用模块化设计：凭据存储 + 定时任务 + HTTP 通道 + 运营面暴露
- 通过反编译桌面客户端 `app.asar` 逆向分析 API 契约（类似 ZCode 集成路径）

**Qoder 特征**:
- 双区域客户端：国际版（api6.qoder.com.cn）与国内版（api.qoder.com.cn）
- 依赖 Chromium os_crypt v10 + Windows DPAPI 加密凭据
- Token 格式：dt-/drt-前缀的 OAuth device flow token

---

## 2. 已完成事项 ✅

### 架构探索与原型验证 (Turn 1-3)
- [x] 分析 Qoder 客户端目录结构 (`C:\opt\workstations\agents\Qoder`)
- [x] 解析 RelayGate 现有项目架构（routes/jobs/credentials 分层）
- [x] 确认 ZCode 为最接近的参考实现
- [x] 提取 app.asar 文件树（4658 files, 141MB）
- [x] 导出全部业务代码到 logs/qoder-code（568 files, 61.5MB）

### P1 核心模块开发 (Turn 4)

#### 数据层改造
- [x] **platform/variant.js**: 新增 QODER 变体定义（双区域域名/路径/能力位/错误码表）
- [x] **credentials/db.js**: SQLite accounts 表新增 `qoder_realm` 列
- [x] **credentials/store.js**: 
  - rowToDecrypted() / acctToRow() 增加 qoder_realm 字段读写
  - INSERT 语句添加 qoder_realm 列和对应占位符
  - 生成账号 ID 逻辑保持加密随机性

#### Qoder Crypto 解密模块
- [x] **src/qoder/crypto.js**: 
  - 实现 Chromium os_crypt v10 解密（v10 + nonce(12) + AES-256-GCM）
  - 通过 PowerShell 调用 Windows DPAPI 读取 Local State 中的加密密钥
  - 解密结果结构化：schemaVersion, token, refreshToken, expiresAt, user 对象
  - 异常类型：QoderCryptoError（含 cause 链）

#### 本地凭据扫描模块
- [x] **src/qoder/local.js**:
  - 自动扫描双区域客户端凭据（%APPDATA%\qoder\auth.v1.dat）
  - 按安装路径判定 realm（避免误判 fastEndpoint 域名的 .com.cn 陷阱）
  - 返回脱敏后的完整账号对象（含 entitlementSnapshot）

#### 测试验证
- [x] 成功解密并导入国际版账号（uid=U16970...）
- [x] 成功解密并导入国内版账号（uid=U20555...）
- [x] 验证 credentials/store add/get CRUD 完整性

---

## 3. 进行中事项 🔄

### 待完成的核心模块

| 模块 | 状态 | 关键工作 | 阻塞项 |
|------|------|---------|--------|
| src/qoder/client.js | ✅ 已写代码 | realm-aware base URL + desktop headers（cosy-clienttype/cosy-version/cosy-machine*） | 无 |
| src/qoder/rewards.js | ✅ 已写代码 | campaigns 查询 / claim 领取 / quota 归一化 | 无 |
| src/jobs/qoder-rewards.js | ⏳ 未写 | 每日 10:00 自动领取（UTC+8）、幂等重试策略、通知机制 | 等待 rewards.js 验收 |
| src/routes/qoder.js | ⏳ 未写 | 挂载/v1/qoder端点：status/rewards/list/claim/admin 管理 | 等待 variant/client/rewards 稳定 |
| upstream/balance.js | ⏳ 未写 | refreshQoderBalance 分支（addonQuota vs userQuota） | 等待 rewards.js 字段定义 |
| pricing-calib.tsx | ⏳ 未写 | CredentialsPage 组件增加 Qoder 专属配额展示 | 等待 balance.js |

### 关键决策点
- **Header 策略**: 仅发送基础三头（User-Agent/cosy-clienttype/cosy-version），不发 machine 六头 → 避免被服务端过滤活动
- **Realm 标识**: 必须从安装路径静态判定（国际版 endpoint 缓存可能是 .com.cn），而非动态猜域名后缀
- **积分有效期**: validity.mode='RELATIVE_DAYS', days=30 → "领取后 30 日" 非固定月底

---

## 4. 待办与下一步 📋

### P0 - 立即执行（本周内）
1. **整合 client.js 与 rewards.js**  
   - 确保 request() 返回正确的 envelope 格式
   - 测试 campaigns API 实际调用（需真实账号 token）
   
2. **编写 jobs/qoder-rewards.js**  
   - scheduler 触发器：`CRON: '0 10 * * *'`
   - 遍历 enabled 账号并行探测（错峰 spreadMinutes=5min）
   - 失败重试策略：3 次退避（5s/10s/20s）

3. **注册路由**  
   - routes/index.js 中 `app.use('/v1/qoder', require('./routes/qoder'))`
   - admin-auth 中间件保护管理端点

### P1 - 本迭代内
4. **上游平衡刷新扩展**  
   - upstream/balance.js 中判断 `if (acct.edition === QODER)` 分支
   - addonQuota 写入 entitlementSnapshot.balances[]

5. **Web Dashboard 适配**  
   - web/src/app/nav.ts 添加 Qoder 入口图标
   - CredentialsPage.tsx 渲染 Qoder-specific quota 表格

6. **测试覆盖**  
   - mock 测试：qoder-rewards.js（campaigns 空/已领/可领三种场景）
   - 集成测试：真实 token 的 claim 流程

### P2 - 后续优化
7. **COSY 签名 + QMC 模型目录同步**  
   - cosysign 算法（需要抓包分析签名头）
   - 定时拉取 catalog from upstream

8. **PAT 支持**  
   - 手工导入 pt-前缀 Personal Access Token
   - OAuth 设备流引导页面

---

## 5. 阻塞与风险 ⚠️

| 问题 | 影响范围 | 缓解方案 | 责任 |
|------|---------|---------|------|
| 无真实 Qoder 账号 token | 无法端到端验证 claims | 先写 mock 测试，待自有账号上线实测 | Dev |
| COSY 签名未知 | model catalog 无法同步 | 延后处理，优先保证 credits claim | Tech Lead |
| macOS/Linux 不支持 DPAPI | 服务器无法扫描本机凭据 | 仅限 Windows 桌面客户端场景；服务端走人工导入 API | — |
| Qwen3.8-Flash 限免规则不明 | 模型定价策略需澄清 | 待官方文档确认（目前只知每日 100 Credits） | PM |

**已知技术债**:
- `qoder_extracts/` 临时文件应清理或归档
- 缺少完整的 unit test suite（zcode-rewards.test.js 可复用）

---

## 6. 关键决策与约束 🔑

### 架构约束
1. **遵循 RelayGate 分层模式**: routes薄→transform纯函数→upstream单一通道→auth复用
2. **不破坏现有数据库 schema**: 新列 `qoder_realm` 默认 NULL 兼容旧账号
3. **单事实源原则**: 所有 Qoder 域名/路径/错误码必须从 variant.js 导出
4. **敏感数据零泄露**: 凭据解密过程在内存进行，不落盘明文

### 业务约束
- **每日一次领取**: 同一账号当日重复 claim 会返回 replayed:true（幂等安全）
- **时间窗口**: UTC+8 10:00（中国时区），跨时区需做用户本地化提示
- **配额隔离**: addonQuota ≠ userQuota（防止混用导致超额扣费）

---

## 7. 新会话启动任务清单（含优先级）🎯

```markdown
## Day 1 - Core Integration
[P0] 验收 src/qoder/client.js 与 variant.js 的一致性
[P0] 验收 src/qoder/rewards.js 的请求/响应封装正确性
[P0] 编写 src/jobs/qoder-rewards.js 的定时调度逻辑
[P1] 注册 src/routes/qoder.js 端点到 index.js

## Day 2 - End-to-End Testing  
[P1] 创建 tests/qoder-rewards.test.js 单元测试（mock campaigns）
[P1] 使用真实 token 进行 claim 接口手动验证
[P2] 运行 npm test 全量回归确保不破坏现有功能

## Day 3 - Dashboard & Balance
[P2] upstream/balance.js 添加 refreshQoderBalance()
[P2] web/src/pages/CredentialsPage.tsx 显示 Qoder quota
[P2] 更新 docs/qoder-integration.md 使用指南

## Week End Deliverable
✅ 可运行的 Qoder 积分自动领取服务
✅ Web dashboard 可见账号配额状态  
✅ 完整的测试报告与部署文档
```

**备注**: 
- 信息不足处标注"待确认"：COSY 签名算法、Qwen3.8-Flash 具体限免条件 → 需官方文档或技术支持确认
- 临时提取文件 `logs/qoder-extracted/` 建议归档至 `archive/qoder-asar-exports/YYYYMMDD`

---

_文件生成时间：Session 解析完成于当前会话_
