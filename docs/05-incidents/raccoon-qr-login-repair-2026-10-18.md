# 扫码登录失效根因与修复方案（2026-10-18 实证）

## 一、结论（先说重点）

**你遇到的「微信端提示二维码过期」不是过期问题，是二维码指向的页面已经被商汤下线了。**

网关当前实现的扫码链路（沿袭参考项目 `dsh-our-free-model` 的 vendor 移植）：

```
二维码 URL  = https://xiaohuanxiong.com/login/mp?code=<自造32hex>&appname=商汤小浣熊官网
轮询接口    = POST /api/web/auth/v1/login_with_qrcode_code   {qrcode_code}
```

实测（2026-10-18）：

| 探测 | 结果 |
|---|---|
| `GET /login/mp`（任意 code / UA） | **HTTP 404「页面不存在」**（Next `_not-found` 页） |
| `POST /api/web/auth/v1/login_with_qrcode_code` | HTTP 200，但 `status` 恒为 `pending`（旧端点仍在，但不与新前端联动） |
| 服务端签发码访问 `/login/mp` | 依旧 404 |

根因：**官方前端已把扫码整套搬到新的 IAM API**（`/api/iam/v1/*`），
`scan_path` 依旧返回 `/login/mp`，但那个静态页在 Next 站点里**没有被部署**。
微信扫开就是 404 → 微信显示「二维码已过期/无效」。

## 二、官方新链路（从官网 chunk 逆向，已实测可用）

官网登录页（`https://xiaohuanxiong.com/login`，2026-10-18 线上版本）的扫码：

```
POST /api/iam/v1/auth/mp/qrcode        创建（body 可为 {} 或 {product_codes:[...]}）
   ← { qrcode_code: "qr-<uuid>", scan_path: "/login/mp",
       expires_in: 300, poll_interval: 2, status: "pending" }
POST /api/iam/v1/auth/mp/qrcode/login  轮询 {qrcode_code} → status pending|logging|canceled|success
PUT  /api/iam/v1/auth/mp/qrcode        取消 {qrcode_code, status:"canceled"}
```

二维码 URL 构造（chunk 309 原文，含同源与路径白名单校验）：

```js
new URL(scan_path, origin)                 // origin = qrOrigin = https://xiaohuanxiong.com/
  + ?code=<qrcode_code>&appname=<brand>&source=platform
```

已实测验证：
- `POST /auth/mp/qrcode` → 200，`qrcode_code=qr-01a14f9e-…`，`expires_in=300`
- `POST /auth/mp/qrcode/login` → 200，`status=pending`
- `PUT /auth/mp/qrcode` → 200

**注意**：`code` 由**服务端签发**，客户端不再自造。我们旧的 `generateQrCode()`
（本地 32 hex）在新体系里毫无意义。

## 三、附带发现：短信登录路径也需要重新评估

官网同一套 IAM 客户端（chunk 280 模块 56098）还有：

```
POST /api/iam/v1/sms/send                        {nation_code, phone, captcha_token, scene:"login"}
POST /api/iam/v1/auth/login/sms                  {nation_code, phone, verification_id, verification_code}
POST /api/iam/v1/auth/login/password/{phone|email}
```

其中 `sms/send` 需要 `captcha_token`（阿里云滑块，`scene=1pkmy0x3`、`prefix=hk1r5l`
与旧文档一致）。所以「短信登录」仍绕不开滑块，**本次不做**；
但新链路里它至少是个**明确的、可独立解决的**障碍（旧文档把它和扫码混在一起谈）。

## 四、修复方案

### P0：把扫码切到新 IAM 链路（这是让「扫码能登上」的唯一路径）

改动范围（集中在 Raccoon 一个渠道，不动其它平台）：

1. `src/platform/variant.js` 的 `[RACCOON].paths`：
   - 新增 `qrCreate: '/api/iam/v1/auth/mp/qrcode'`
   - 新增 `qrPoll: '/api/iam/v1/auth/mp/qrcode/login'`
   - 新增 `qrCancel: '/api/iam/v1/auth/mp/qrcode'`
   - 旧 `loginWithQrcode` 保留但标注 deprecated（仅作对照，不再使用）
   - `identity.qrOrigin`、`identity.qrSource='platform'` 入库，避免 URL 拼接散落各处

2. `src/raccoon/product.js`：
   - 新增 `buildQrUrl({origin, scanPath, code, brand, source})`，复刻官网同源/路径白名单
     校验（防 `//evil.com` 与 `#` 注入；`scan_path` 来自服务端，必须当不可信输入）
   - 删除/冻结 `generateQrCode()` 的“自造 code”语义，改为透传服务端签发码

3. `src/raccoon/auth.js`：
   - `startLoginSession()` 改为**先调 `qrCreate`**，拿 `qrcode_code` / `scan_path` /
     `expires_in` / `poll_interval` 再入 session（session 仍是进程内内存态，5 分钟）
   - `pollLoginSession()` 改调 `qrPoll`
   - 新增 `cancelLoginSessionRemote()` 调 `qrCancel`（旧版只是删本地会话，
     服务端那个签发码会悬挂到自然过期）

4. `src/test/raccoon.test.js`：补新链路的单测（用本地 HTTP mock，不打真上游），
   重点钉住 `buildQrUrl` 的白名单行为与轮询状态机（pending 兜底不变）。

### P1：把「本机导入」的语义修对（你指出的第二个问题）

`local.importFromLocal()` 现在是一次性快照。改成「跟随客户端当前账号」：

- 导入时校验：若库里已有同 userId 但 token 已失效（401），
  且本地 `auth.json` 是**另一个** userId → 不覆盖，标记失效并告警
- 文档写明：**本机导入只能稳定服务客户端当前那一个账号**；
  多账号请用扫码（各自独立会话，不受客户端切号影响）

### 不做的事

- 不做短信登录（新 IAM 的 `sms/send` 实测仍强制滑块 `captcha_token`；
  参考项目当年用的是旧 `/api/web/auth/v1/send_sms`，那条链路同样要滑块 ——
  「不用滑块直接发」在两代 API 上都实测不通）
- 不动其它四个渠道

## 六、实施结果（2026-10-18 深夜完成）

### 已落地

| 改动 | 文件 | 内容 |
|---|---|---|
| 新 IAM 扫码三件套 | `platform/variant.js` | `qrCreate/qrPoll/qrCancel` 路径 + `qrOrigin/qrSource/qrAppname` 身份 |
| URL 白名单构造器 | `raccoon/product.js` | `buildQrUrl()` 复刻官网两层校验（原文 + decode 后），挡跳域/`//`/hash/双编码 |
| 服务端签发码 | `raccoon/auth.js` | `startLoginSession()` 改异步，先 `qrCreate` 拿 `qr-<uuid>` 再拼 URL |
| 过期如实上报 | `raccoon/auth.js` | 轮询识别 `AUTH_QRCODE_EXPIRED`（**必须读 `envelope.raw.code`**，`envelope.code` 已被折成 0）→ 回 `expired` 让前端换新码 |
| 远端取消 | `raccoon/auth.js` | `cancelLoginSession()` 同时调 `qrCancel`，签发码不再悬挂 |
| host 可注入 | `raccoon/client.js` | `HOST()` 改为调用时读取，单测可把上游指到本地 mock |
| 全链路 mock 测试 | `test/raccoon.test.js` | 40/40 通过：签发码 → 轮询 pending→success → 落库 → 过期码识别 |

### ⚠️ 遗留：`/login/mp` 承载页服务端仍未部署（**上游半损坏**）

代码侧已全部切到新链路，但真机验证发现：即使拿**服务端签发码**访问
`/login/mp`，仍返回 404（Next `_not-found` 页）。已排除的可能：

- ❌ UA 问题：微信 iOS / Android 完整头、PC、移动端全试过，都 404
- ❌ 头部问题：RSC / Referer / Cookie / Accept 变体全试过，都 404
- ❌ 参数问题：有无 `appname`/`source`、官方 45 位 code、纯 32 hex，都 404
- ❌ 域名问题：`www.` / `sta-volc.` / `doc.` 全试过，`mp.`/`code.`/`open.` 无解析
- ✅ API 本身健康：`qrCreate`/`qrPoll`/`qrCancel` 全 200，`scan_path` 返回 `/login/mp`

结论：**官方把 API 已上线、但 H5 承载页还没部署**（或只对特定灰度开放）。
这正是「参考项目时代能扫、现在不能扫」的原因——不是我们实现漂了，
是上游把自己拆了一半。

### 对用户的实际影响与对策

1. **扫码登录当前不可用**（等上游部署 `/login/mp` 后自动恢复，代码无需再改）。
2. **多账号唯一可用路径**：
   - 客户端当前账号 → 本机导入（已有）
   - 其它账号 → 手机号 + 密码登录（新 IAM 有 `auth/login/password/phone`，
     需要账号设过密码；可作下一步实现）
3. **Anthony 补登**：等 `/login/mp` 恢复后用面板扫码，或给该账号设密码后走密码登录。
4. **保活不受影响**：Olivia 的每日保活与本次改动无关，照常 09:05 自动跑。

### 后续建议（未做）

- 密码登录：`POST /api/iam/v1/auth/login/password/{phone|email}`，
  需账号先在官网设置密码；加密方式与手机号一致（AES-128-CFB 同 key）
- 监控 `/login/mp` 恢复：定时 GET 探测，恢复后自动把扫码入口点亮（面板已按
  `smsAvailable=false` 的模式预留）

## 五、验证计划

1. 单测：`npm test` 全绿（新增用例 ≥4）
2. 真机：本地起 mock IAM 服务，跑通「创建 → 轮询 pending → 扫码 → success → 落库」
3. 真机（只读）：用真实签发码走一遍 `qrCreate → qrPoll → qrCancel`，
   确认返回形状与实现一致（已在方案设计阶段实测通过）
