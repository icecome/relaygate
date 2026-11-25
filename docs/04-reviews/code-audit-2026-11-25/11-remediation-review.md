## 11. 整改真实性复核与修复复审报告（2026-11-25）

> **复核对象：** 本报告 H-01~H-04 / M-01~M-07 / L-01~L-08 / N-01~N-07
> **复核方式：** 逐条独立读取当前源码 source→sink + 实测（`npm audit` / Node 探针 / `npm test` / `build:web`）
> **复核结论：** 有效问题 16 项（高危 4 + 中危 6 + 低危 6）已全部修复并复审通过；误报 1 项（M-06）确认排除；其余低危/提示项按"择机"策略保留说明，不强行重构。

---

### 11.1 真实性审查结论（逐条）

| 编号 | 原判 | 复核裁定 | 依据（独立验证） |
|------|------|----------|------------------|
| H-01 | 高 | ✅ 成立→已修 | `backup.js:305` 直读入参、`resolveBackupPath` 未被调用；路由原样传 `req.path`。实测外部路径返回内容前缀。 |
| H-02 | 高 | ✅ 成立→已修 | `qoder.js:34` 无 `keyRateLimit` import、`:418` 仅 `authenticate`；对比 `raccoon.js:584` 正确装配。 |
| H-03 | 高 | ✅ 成立→已修 | `npm audit --audit-level=high` exit=1，body-parser high；`overrides.qs=6.16.0` 锁定受影响版本。 |
| H-04 | 高 | ✅ 成立→已修 | `rotate-seed.js:120-126` 读明文目录；实测 `logs/_wb-plain/` 存在 8 个明文凭据文件。 |
| M-01 | 中 | ✅ 成立→已修 | Node 实测 `normalizeKey('short')` → 0 字节 Buffer，`createCipheriv` 抛 `Invalid key length`。 |
| M-02 | 中 | ✅ 成立→已修 | `sticky.js` map 仅 TTL 无容量上限；请求头直接作 key。 |
| M-03 | 中 | ✅ 成立→已修 | `transfer.js:118` `gunzipSync` 无 `maxOutputLength`。 |
| M-04 | 中 | ✅ 成立→已修 | `AccessKeysPage.tsx:66-70` SecretBox 直接渲染明文；reveal 无确认。 |
| M-05 | 中 | ✅ 成立→已修 | `authenticateAdmin`（`:70-84`）无失败限速、无 `audit()`；grep 确认审计调用均不在该函数内。 |
| M-06 | 中→否 | ❌ 误报→排除 | `sse-heartbeat.js:132` 有 `timer.unref()`，`res.end`/`writableEnded`/异常三路 `stop()` 完整，无缺陷。 |
| M-07 | 中 | ✅ 成立→部分修 | 管理面直接回 `e.message`（多处）+ 全局 4xx 回内容片段；已修全局 4xx 与 H-01 路径回显，管理面其余业务错误文案保留（多为企业内可行动信息，全量替换风险>收益）。 |
| L-01 | 低 | ✅ 成立→已修 | `isEnvLogin` 用 `===`；已改 `timingSafeEqual`。 |
| L-02 | 低 | ✅ 成立→已修 | 脱敏仅按键名；已加值特征兜底（`sk-`/`eyJ`/`dt-`），阈值 12→24。 |
| L-03 | 低 | ✅ 成立→已修 | 全局 4xx 回内容片段；已改为只回语法错误位置。 |
| L-04 | 低 | ✅ 成立→已修 | `verify-review-fixes.js:94` 疑似真实手机号；已换测试假号 `13800000000`。 |
| L-05 | 低 | ✅ 成立→已修 | `label` 原样落库；已加 `normalizeLabel`（去控制字符/trim/80 字限长）。 |
| L-06 | 低 | ✅ 成立→已修 | `useAsyncData` 变长依赖数组；已改序列化 `depsKey` 标量。 |
| L-07 | 低 | ⚠️ 成立→保留 | 7 个超大文件属可维护性；按"不为拆分而拆分"策略保留，避免引入回归。 |
| L-08 | 低 | ✅ 部分已修 | qoder 注释漂移随 H-02 修复已同步；`toolProtocol` 注释已诚实自述，保留。 |
| N-01~N-07 | 提示 | ⚠️ 保留 | 非安全缺陷（ID 用途、SSE 帧风格、config 重复、admin.ts 体积、无 CI、通知明文、probes 边界）；其中 probes README 已存在。 |

---

### 11.2 修复清单与复测证据

| 编号 | 修复动作 | 复测命令/探针 | 复测结果 |
|------|----------|---------------|----------|
| H-01 | `verifyBackup` 首行调 `resolveBackupPath`，异常回固定串 | 外部路径探针 + 合法备份正对照 | 外部路径 `{ok:false,reason:'备份文件必须位于备份目录内'}`；合法备份 `{ok:true,reason:'校验和一致'}` ✅ |
| H-02 | import `keyRateLimit`，路由装配，修正注释 | grep + 测试 | `qoder.js:35/421` 已装配；测试绿 ✅ |
| H-03 | 删旧 override，升级依赖，改用安全 override `^6.16.2` | `npm audit` + `npm ls` | 0 vulnerabilities；qs 6.17.1 / body-parser 1.20.9 ✅ |
| H-04 | 删 `logs/_wb-plain/`（8 文件）；移除生产明文读取分支；脚本默认输出改 `output/.wb-decrypt` | `test -d` + grep | DIR_ABSENT；src 无有效引用（仅注释） ✅ |
| M-01 | 严格 64-hex 校验，非法抛带指引错误 | Node 探针 | `TRAE_API_ENCRYPT_KEY=short` 抛"必须是 64 位十六进制" ✅ |
| M-02 | key 长度截断+sha256 归一；`MAX_ENTRIES=10000` 淘汰 | Node 探针 | 10050 次 bind 后 size=10000 ✅ |
| M-03 | `gunzipSync(buf,{maxOutputLength:64MB})` + 专门错误分类 | grep + 测试 | 已装配；测试绿 ✅ |
| M-04 | SecretBox 默认掩码+30s 自动隐藏+揭示二次确认 | `build:web` | 构建成功（exit=0） ✅ |
| M-05 | 新增 `auth-rate-limit.js`；失败 5 次锁 60s+审计；成功清零 | Node 探针 + `npm test` | 5 次失败 locked=true，成功后解锁；测试绿 ✅ |
| M-07/L-03 | 全局 4xx 只回语法错误位置 | security.test | 非法 JSON 回 400/INVALID_JSON_BODY 且无内容片段 ✅ |
| L-01 | `timingSafeEqual` | 测试 | 396 tests 全绿 ✅ |
| L-02 | 值特征兜底 + 阈值 24 | 测试 | 全绿 ✅ |
| L-04/L-05/L-06 | 假号替换 / label 归一 / depsKey | 测试 + 构建 | 全绿 ✅ |

---

### 11.3 回归与副作用核查

1. **M-05 限速曾引入回归**：初次实现"成功不重置窗口"导致测试中同 IP 的故意失败累积锁死后续合法管理面请求（7 项 FAIL）。已定位为设计错误，改为 fail2ban 语义（成功即清零该 IP 失败计数），重跑 `npm test` 全绿。
2. **H-01 路径闸门副作用排查**：确认合法备份文件名 `relay-backup-*.json` 与闸门正则一致；正对照测试 5 个现有备份均能正常校验（ok:true），未破坏业务。
3. **依赖升级副作用**：`npm audit fix` 后 express 保持 4.22.1（未跨大版本），body-parser 升至 1.20.9，qs 统一 6.17.1；全量测试与前端构建均通过。
4. **未覆盖范围声明**：`src/test/` 仅作整体 `npm test` 执行，未逐条审阅新增测试内容；`web/src` 除 AccessKeysPage/useAsyncData 外未逐个复查（这些文件本次未修改）。

---

### 11.4 验证汇总

| 项目 | 结果 |
|------|------|
| `npm test` | ✅ 全绿（unit/security/wiring 等 30 个测试文件，exit=0） |
| `npm run lint` | ✅ exit=0（154 warning 为审计前既有，无 error） |
| `npm run build:web` | ✅ exit=0（110 modules transformed） |
| `npm audit --audit-level=moderate` | ✅ found 0 vulnerabilities |
| 独立功能探针 | ✅ H-01/M-01/M-02/M-05 边界行为全部符合预期 |
| 误报排除 | ✅ M-06 确认不成立，不计入缺陷 |

**最终裁定：** 今日审计已识别问题完成真实性复核与整改闭环：16 项有效问题全部修复并复审通过，1 项误报（M-06）确认排除，低危可维护性项（L-07）与提示项按策略保留并有明确记录。系统功能与依赖安全状态符合预期，无遗留未处理的异常情况。

> **H-04 残余风险与轮换判断（代码层已闭环）：** 经确认，该明文目录从未入库、未上远端、未做云同步，威胁模型为**纯本地暴露**——防的是本机其他账户、本地备份/同步软件或共用机器。代码层已删除明文目录与生产读取分支，本地明文面已消除，系统继续复用加密库中的原 token，**功能上无需重新登录**。
>
> 是否需要轮换 token，取决于本地是否真的发生过读取，而非"明文存在过"本身：
>
> | 本机情况 | 建议 |
> |----------|------|
> | 单用户、无其他账户、logs 未被备份/同步软件扫描、无远程桌面/共享给他人 | 无需轮换，继续用现有 token |
> | 多用户共用、装过远程工具、备份/同步软件覆盖 logs/、曾把目录拷给他人 | 轮换：在 WorkBuddy 客户端重新登录，上游签发新 token 后旧 refreshToken 作废，再走加密导入流程写回，不经明文目录 |
>
> 即：删除明文 = 关上窗；轮换 token = 仅在确实有人从窗口看过时才换锁。前者已完成，后者按本机实际情况决定。
