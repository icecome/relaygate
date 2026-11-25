## 7. 补充发现（N-06、N-07）

这两条在分文件清单中已出现，独立成节说明其依据与建议。

---

### N-06 通知渠道凭据明文落盘，与账号 token 保护口径不一致

| 项 | 内容 |
|----|------|
| **文件** | `src/notify/settings.js:13-35,154`；`src/lib/settings-store.js:94` |
| **等级** | ⚪ 提示（偏"中危中的低项"，因权限边界由 OS 提供而不升级） |

**问题描述**

`notify-settings.json` 中的三类渠道凭据均为**明文 JSON**：

```js
// src/notify/settings.js:13-23
const FIELDS = [
  'webhookUrl', 'webhookMethod', 'webhookHeaders', 'webhookTitleKey', 'webhookContentKey',
  'serverChanSendKey',   // ← 明文
  'pushPlusToken',       // ← 明文
  'telegramBotToken',    // ← 明文
  'telegramChatId',
];
```

写入路径最终落到 `lib/settings-store.js:94` 的 `writeJsonAtomic(FILE(), stored)`，**无任何加密**。

这形成口径分裂：账号 token 走 `lib/crypto.js`（AES-256-GCM），`api_keys` 走 `key_enc` 加密列，备份走 `encryptPayload`，导出走 scrypt+GCM——唯独通知凭据是明文。

**影响**

- `serverChanSendKey` / `pushPlusToken` / `telegramBotToken` 泄露可让攻击者向用户的推送渠道**发送伪造告警**（社工面），或读取渠道历史。
- 危害低于账号 token（不能直接消耗积分），且文件位于 `output/.trae-api/`（受 OS 文件权限保护）。
- 但"同类敏感数据保护不一致"本身是可维护性缺陷：未来新增凭据字段时，维护者无法从代码中判断"该加密还是不该加密"。

**修复建议**

方案 A（最小改动）：把三个 token 字段纳入 `lib/crypto.js`，保存时加密、读取时解密，字段名改为 `*Enc`，`getEffective` 内解密。前端已在掩码展示，无需改动接口形状。

方案 B（架构对齐）：`lib/settings-store.js` 增加 `secret: true` 字段描述符，由 store 统一加解密。这样 `notify`、`backup`、`balance-refresh` 等所有设置文件共享同一口径。

建议采 B——`settings-store.js` 已是五个设置模块的统一底座（`:5-8` 注释），加一个描述符的成本远低于各模块自己实现。

---

### N-07 `scripts/probes/` 缺少"非生产代码"标识

| 项 | 内容 |
|----|------|
| **文件** | `scripts/probes/`（79 个文件） |
| **等级** | ⚪ 提示 |

**问题描述**

`scripts/probes/` 下 79 个一次性调试脚本（`probe-wb-*.js`、`wb-*.js`、`dsh-*.js` 等）全部被 Git 跟踪。它们：

- 大量重复的 `fetch` + header 构造样板，各自硬编码上游路径；
- 部分脚本会读取真实凭据、打印请求体、把响应写盘；
- 无参数校验、无超时、无错误处理。

**关键判断：这些脚本不应投入重构。** 它们的价值是"事故现场的一次性取证记录"，重写会丢失当下的探针语义。真正的问题是**它们与生产代码的边界不清**——未来维护者可能把 `probes/` 里的写法当作范式复制进 `src/`。

**修复建议**

1. 在 `scripts/probes/README.md` 顶部加醒目声明：

   ```
   ⚠️ 本目录为一次性调试探针，非生产代码。
   - 不保证正确性、不保证不打印凭据、不代表推荐写法。
   - 禁止被 src/ 或 scripts/ops/ 引用。
   - 新需求请走 src/，不要在这里加脚本。
   ```

2. 加一条 simple 的 CI 检查：`grep -rn "require.*scripts/probes" src scripts/ops scripts/verify` 必须为空。

---
