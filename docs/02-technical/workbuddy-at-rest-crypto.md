# WorkBuddy 凭据加密（at-rest）逆向结论与导入防护修复

## 背景

2026-10-04 新增的 5 个 WorkBuddy 账号余额查询为 0（显示 `—`），签到/刷余额全部上游 401。
排查确认根因后已完成修复与账号恢复，本文记录加密机制结论与防护实现，供后续客户端升级时对照。

## 一、根因

1. WorkBuddy 桌面客户端自 2026-09-24 版本起，把 `workbuddy-desktop.info` 中的
   `auth.accessToken` / `auth.refreshToken` 从明文字符串改为
   `{$wbEncrypted: 1, envelope: "<base64>"}` 加密对象（`phoneNumber`、`nickname` 同样处理）。
2. 管理面板「跨机粘贴导入」（`POST /v1/workbuddy/import` 的 `infoJsonText` 分支）缺少
   本机抓取路径已有的 `plainToken()` 归一化防护，加密对象被 `String()` 成
   字面量 `[object Object]` 直接入库。
3. 垃圾 token 导致上游 billing/chat 一律 HTTP 401，`balance` 始终为 null，
   前端显示 `—`；账号调度（`balanceOk`）对 `balance=null` 视为可用，所以不影响转发但签到/余额全挂。

## 二、加密机制逆向结论（供后续维护）

以下结论全部来自对客户端 `app.asar` / `app.asar.unpacked/cli/dist/codebuddy-headless.js` 的
反编译对照 + 本机实测验证，非猜测。

### 数据结构

- envelope（字段级）：`{suite: 1, keyId: <16hex>, nonce: b64(12B), authTag: b64(16B), ciphertext: b64}`
- keyblob（`~/.workbuddy/keyblob`）：
  `{version:1, keyId:<16hex>, slots:[{type:"static-v1", protectorKeyId:<16hex>, wrapped:<envelope b64>}]}`
  - `keyId` = master key 的 `sha256` 前 16 hex
  - `protectorKeyId` = protector key 的 `sha256` 前 16 hex
- key payload（由 patched Electron 原生 API `electron.workbuddyStorage.loggerGet()` 提供）：
  `{version:1, atRestSecretKey: "<canonical base64, 32B>", atRestDeveloperPublicKey: {...RSA-3072}}`

### 密钥派生链

```
protectorKey = sha256( utf8(atRestSecretKey 的 base64 字符串) )      // 32B
protectorKeyId = sha256(protectorKey) 前 16 hex                     // 实测 9127dea1b44020a7
masterKey     = AES-256-GCM-open(protectorKey, keyblob.slots[0].wrapped)   // 32B
masterKeyId   = sha256(masterKey) 前 16 hex                          // keyblob.keyId
token 明文    = AES-256-GCM-open(masterKey, envelope)                // 实测字段级 envelope 同用 protector keyId
```

实测确认：**字段级 envelope 直接用 protectorKey 解**（envelope.keyId === protectorKeyId），
masterKey 仅用于 keyblob 自身与整文件加密（WBEF1）。

### AES-GCM AAD 构造（字段级，suite=1，sym-v1）

```
"WB-AAD\0" (ascii)
0x01                                    // version
lenPrefix("WBEV1")                      // formatId(field) = u32be(len) || utf8
lenPrefix("sym-v1")                     // scheme
u32be(1)                                // suite
lenPrefix(keyId)                        // 16 hex
0x02                                    // framingCode: file=1 field=2 record=3 stream=4
0x00                                    // optional uint64 sequence: absent
0x00                                    // final: absent → 0
```

其中 `lenPrefix(s) = u32be(utf8(s).length) || utf8(s)`。
整文件 framing（WBEF1）时 framingCode=1；AAD 域名常量为 `WB-AAD\0`（普通）与 `WB-WRAP\0`（keyblob wrap 用）。

### 密钥材料的存放（无法离线获取的部分）

`atRestSecretKey` payload 由 patched Electron 的原生模块
`electron_api_workbuddy_storage.cc`（绑定名 `electron_browser_workbuddy_storage`，
API：`loggerGet`/`loggerIn`/`loggerOut`）在 main 进程内提供。
实测排除了以下存放点：LevelDB（Local Storage）、Session Storage、IndexedDB、
Windows 凭据管理器、HKCU 注册表、`.workbuddy` 下的全部 JSON/SQLite、
`.workbuddy-key-fallback/connector-keys/*.key`（8 个 32B 文件，keyId 均不匹配）、
`connectors/<uid>/.master.key`（5 个，均不匹配）。
客户端运行期间，payload 以明文 JSON 形态存在于 main 进程堆内存中
（`"atRestSecretKey":"..."` 可读），可用内存扫描定位。

### 本机恢复实操（已完成）

1. 退出客户端（单实例锁）；用管理员 PowerShell 对 main 进程（内存最大者）做
   `ReadProcessMemory` 全堆扫描，定位 `"atRestSecretKey":"<44char canonical b64>"`。
2. 派生 protectorKey（sha256），校验 `keyId === 9127dea1b44020a7`。
3. 按上述 AAD 构造解 5 个账号 `.info` 的 accessToken/refreshToken envelope，
   得到明文 JWT（1361B）与 refreshToken（700B）。
4. 写回 `trae-relay.db`（仅覆盖 `[object Object]` 垃圾值），同步 `expiredAt`。
5. 逐账号调 `refreshBalance` 实测：余额全部恢复（2400/2500/2498/2500/2500）。

## 三、代码修复

`src/routes/workbuddy.js` 的跨机粘贴导入分支新增防护：检测
`auth.accessToken.$wbEncrypted` 为对象时直接返回
`400 { code: "WB_TOKEN_ENCRYPTED" }`，提示改用「方式一：抓取本机客户端登录态」。
本机抓取路径既有 `plainToken()` 归一化防护不变。

测试：`src/test/unit.test.js` 新增用例校验防护判定式与错误码存在；
全套 136 + 11 通过。

## 四、遗留注意事项

- 客户端下次大版本升级若更换 `atRestSecretKey` 或 AAD 域常量，需按本文第二节重新对照。
- `output/wb-decrypted-tokens.json` 为一次性恢复产物（0600），确认账号全部正常后可删除。
- 管理面板若后续支持「从客户端文件直读」，必须先走 `plainToken()` 同源的加密对象检测，
  任何把对象 `String()` 后入库的路径都会复现本次故障。
