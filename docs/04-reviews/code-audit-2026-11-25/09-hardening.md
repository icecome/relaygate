## 9. 安全加固建议汇总

按"控制面"组织，而非按问题编号。每条均可独立采纳。

### 9.1 访问控制

| 建议 | 覆盖问题 | 说明 |
|------|----------|------|
| **统一转发面限流装配 + 守门测试** | H-02, M-05 | 转发面共 5 个入口：`/v1/chat/completions`、`/v1/messages`、`/v1/responses` 三个由 `index.js:298` 的 `app.use(rateLimitMw)` 统一覆盖（**装配正确**）；而 `/v1/qoder/chat/completions` 与 `/v1/raccoon/chat/completions` 因挂在独立前缀下，必须在路由内自行挂 `keyRateLimit()`——Raccoon 挂对了（`:545`），Qoder 漏了（`:418`）。这正是"逐处手写"的失效点。建议改为"路由注册表 + 统一装配"，并加测试断言每个转发路由的 middleware 链都含 `keyRateLimit` |
| **管理面独立限速通道** | M-05 | 管理面与转发面的威胁模型不同（前者防暴力破解，后者防额度耗尽），不应共用同一 RPM 桶。建议 `auth-rate-limit.js`：按 IP + 全局双维度，5 次失败锁 60s |
| **管理面鉴权失败入审计** | M-05 | `authenticateAdmin` 目前静默 401。审计日志应记录每次失败（IP、UA、时间），这是发现探测行为的唯一手段 |
| **恒定时间比较统一化** | L-01 | 抽出 `lib/safe-compare.js`，`isEnvLogin`、OAuth state（已用 `timingSafeEqual`）、未来的 token 校验共用 |
| **路径闸门内聚** | H-01 | `resolveBackupPath` 存在但靠调用方自觉使用——已漏一处。改为"闸门是访问文件的唯一入口"：把 `fs.readFileSync` 包进 `readBackupFile(p)`，返回已校验的内容，从签名上消除绕过可能 |

### 9.2 敏感数据保护

| 建议 | 覆盖问题 | 说明 |
|------|----------|------|
| **建立"数据分级 → 存储方式"对照表** | H-04, N-06, M-01 | 当前口径分裂：账号 token 加密、api key 加密、备份加密、导出加密，但通知凭据明文、`_wb-plain` 明文、骨架缓存明文。建议在 `docs/02-technical/` 落一张表：数据类别 → 是否加密 → 密钥来源 → 落盘位置 → 保留期。新字段必须查表定级 |
| **禁止生产代码读取"运维产物"目录** | H-04 | `src/` 对 `logs/` 的任何读取都是架构倒置。建议加 CI 检查：`grep -rn "logs/_" src/` 必须为空 |
| **明文敏感文件的生命周期管理** | H-04 | `_logs/_wb-plain/` 不受 `retention.js` 管理（非日期目录）。应为所有"含明文凭据的目录"建立登记与清理策略，或在产出时写入带 TTL 的元数据 |
| **统一设置文件加密能力** | N-06 | 在 `lib/settings-store.js` 的字段描述符上加 `secret: true`，由 store 统一加解密。这是低成本、高一致性的收敛点 |
| **日志脱敏双保险** | L-02 | 键名匹配（现有）+ 值特征匹配（新增 `sk-`/`eyJ`/`dt-` 等前缀）。任何一路命中即打码 |
| **`maskSecret` 阈值上调** | L-02 | 当前 `<=12` 全掩码，13 字符的密钥会暴露 10 个字符。建议阈值 24，并对"中间部分"永不保留 |

### 9.3 输入与资源边界

| 建议 | 覆盖问题 | 说明 |
|------|----------|------|
| **为所有"外部输入 → 资源分配"路径建立预算表** | M-02, M-03 | 已有限制：`MAX_ITEMS=2000`、`maxBodyBytes=16MiB`、`KEY_DEFAULT_RPM=60`、`rateWindowMs`。缺失：内存 Map 容量、解压输出、sticky key 长度。建议集中登记，避免下次再漏 |
| **解压/解析类操作一律带上限** | M-03 | `gunzipSync`、`JSON.parse`（超大字符串）、未来的任何 `unzip`/`inflate`。Node 的 `maxOutputLength` 选项应成为默认习惯 |
| **内存表统一"容量 + TTL"双约束** | M-02 | `rate-limit.js` 已实现容量清理（可作范式），`sticky.js` 只有 TTL。建议抽 `lib/bounded-map.js`，两者共用 |
| **管理端字符串字段统一归一** | L-05 | `label`、`name`、`description`、`tags` 等均应有 `normalizeText(v, maxLen)`：去控制字符、trim、截断。`credentials.js:522` 已有实现，应上提到 `lib/` |

### 9.4 错误处理与信息暴露

| 建议 | 覆盖问题 | 说明 |
|------|----------|------|
| **错误出口分三档** | M-07, L-03 | ① 面向客户端（泛化，`upstream-error.js` 已做，**是范本**）② 面向管理员（含可行动细节，但无路径/内容）③ 服务端日志（全量）。当前②档缺失，导致管理面直接透传 `e.message` |
| **区分"可诊断"与"可泄露"** | L-03 | `entity.parse.failed` 回显内容前缀的价值是"告诉用户 JSON 哪坏了"，但位置信息（`at position N`）已足够，无需回显内容。这是一个可复用的原则 |
| **4xx 白名单化** | M-07 | 全局处理器当前按 `err.type && 4xx` 放行，是黑名单思维（"非此即彼"）。改为显式枚举已知安全类型，未知类型一律泛化 |

### 9.5 依赖与供应链

| 建议 | 覆盖问题 | 说明 |
|------|----------|------|
| **移除无收益的 override** | H-03 | `overrides.qs: "6.16.0"` 既未修复漏洞，又阻断升级。override 应只用于"必须统一版本"的场景，使用时应写注释说明原因与解除条件 |
| **CI 固化依赖门禁** | H-03 | `npm audit --audit-level=high` + `npm outdated` 报告。当前无任何 CI（已核验） |
| **锁定 Node 版本** | — | `package.json:44-46` 声明 `>=22.5`，但实现使用了 `node:sqlite`（Node 22.5+ 实验特性）、`zlib.maxOutputLength`（15+）、`Array.prototype.at` 等。建议加 `.nvmrc` 或 `engines` 精确到 `>=22.5 <25`，避免未来 Node 大版本破坏 `node:sqlite` 行为 |

### 9.6 可维护性（降低复发概率）

本次审计最重要的观察：**H-01 与 H-02 都是"同类实现漏了一处"，不是"不知道要做"**。这指向同一个根因——同类端点的防护靠逐处手写，没有机制保证。

| 建议 | 覆盖问题 | 说明 |
|------|----------|------|
| **把"同类端点一致性"变成可测断言** | H-01, H-02, M-05 | 已有 `src/test/wiring.test.js` 的先例。建议扩充为"路由契约测试"：遍历 `app._router.stack`，断言每个 `/v1/admin/*` 含 `authenticateAdmin`、每个 `/chat/completions` 含 `keyRateLimit`、每个文件访问端点走闸门。**这是投入产出比最高的一条建议** |
| **拆分超大文件（按变更原因）** | L-07 | 优先 `jobs/scheduler.js`（6 类任务）与 `routes/openai.js`（4 条分派分支）。`qoder.js` 的注释漂移正是"文件大 + 同类逻辑分散"的直接产物 |
| **注释即契约，漂移即缺陷** | L-08 | 本项目注释质量高，是资产；但也意味着注释漂移的误导性更强。建议对"声明了安全控制"的注释加标记（如 `// @security`），CI 检查这些标记附近的代码是否含对应中间件 |
| **`probes/` 与生产代码隔离** | N-07 | 加 README 声明 + CI 检查无引用。防止"探针写法"被复制进 `src/` |

---

## 10. 验证清单（整改后使用）

供整改完成后逐项打勾，每项均给出**可执行的验证命令**。

### P0

- [ ] **H-04-1** `logs/_wb-plain/` 已删除
  ```bash
  test ! -d logs/_wb-plain && echo PASS || echo FAIL
  ```
- [ ] **H-04-2** 涉及账号的 refreshToken 已轮换（在 WorkBuddy 客户端重新登录并重新导入，或调用上游 refresh 接口）
  ```bash
  grep -rn "logs/_wb-plain" src/ && echo FAIL || echo PASS   # 生产代码不再引用
  ```
- [ ] **H-03** 依赖漏洞清零（moderate 可接受，high 必须为 0）
  ```bash
  npm audit --audit-level=high; echo "exit=$?"   # 期望 exit=0
  npm ls qs body-parser express                   # qs 应 >=6.16.1 或已无 override
  ```

### P1

- [ ] **H-01** 路径闸门生效
  ```bash
  # 期望返回 { ok:false, reason:'备份文件必须位于备份目录内' }，且不含文件内容
  curl -s -X POST http://127.0.0.1:19900/v1/admin/backup/verify \
    -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
    -d '{"path":"output/.trae-api/encrypt.key"}'
  ```
- [ ] **H-02** Qoder 端点限流生效
  ```bash
  # 连续快速请求超过 KEY_DEFAULT_RPM 后应出现 429 / code=KEY_RPM_LIMIT
  for i in $(seq 1 80); do curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://127.0.0.1:19900/v1/qoder/chat/completions \
    -H "Authorization: Bearer $ACCESS_KEY" -H 'Content-Type: application/json' \
    -d '{"model":"qmodel","messages":[{"role":"user","content":"hi"}]}'; done | sort | uniq -c
  ```
- [ ] **H-02-2** 守门测试存在且通过
  ```bash
  npm test 2>&1 | grep -i "keyRateLimit\|rate.limit.*route" 
  ```
- [ ] **M-04** 前端明文默认遮蔽（人工核对 `AccessKeysPage.tsx` 的 `SecretBox`）

### P2

- [ ] **M-01** 非法密钥格式明确报错
  ```bash
  TRAE_API_ENCRYPT_KEY=my-password node -e "require('./src/lib/crypto').getEncryptionKey()" 2>&1 | grep -i "64 位十六进制"
  ```
- [ ] **M-02** sticky 容量上限（构造 20000 个不同 `x-sticky-key` 后 `/v1/admin/sticky` 的 entries 应 ≤ 上限）
- [ ] **M-03** 解压上限（构造高压缩比导出文件，期望 `TransferInputError` 而非 OOM）
- [ ] **M-05** 管理面失败 5 次后返回 429 + 审计日志出现 `auth.admin_fail`
  ```bash
  grep -c "admin_fail" logs/$(date +%Y-%m-%d)/audit.jsonl
  ```

### 回归

- [ ] `npm test` 全绿（31 个测试文件）
- [ ] `npm run lint` 无新增告警
- [ ] `/health` 返回 `status: 'ok'`，`checks` 全部 `ok:true`
  ```bash
  curl -s http://127.0.0.1:19900/health | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.status, j.checks.filter(c=>!c.ok))})"
  ```

---
