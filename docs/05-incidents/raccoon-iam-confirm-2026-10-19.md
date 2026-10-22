# `iam_confirm_required`（code=200901）根因与修复（2026-10-19 实证）

## 一、现象

扫码登录**成功**、账号落库**成功**，但紧接着查积分：

```
GET /api/web/points/v1/balance
→ HTTP 400  {"code":200901,"message":"iam_confirm_required","details":"IAM confirmation required"}
```

同样报 200901 的端点（实测）：

| 端点 | 结果 |
|---|---|
| `GET /api/web/points/v1/balance` | 400 `200901` |
| `GET /api/web/points/v1/bills` | 400 `200901` |
| `GET /api/web/auth/v1/user_info` | 400 `200901` |
| `POST /api/web/desktop/v1/login/points/grant` | 400 `200901` |

而对照组账号 Olivia（`acct_mvdyjq9jd530a656`）一切正常 —— 它的凭据来自
**桌面客户端本地** `~/.box-agent/config/auth.json`。

## 二、根因

**新 IAM 扫码 success 只返回 `access_token`，不返回 `refresh_token`。**

落库后该会话在 IAM 侧是「**未确认**」状态，未确认的会话打**任何** `/api/web/*`
业务端点都被 IAM 拦回 `200901`。不是账号问题、不是权限问题、不是请求头问题
（逐一排除：UA、`X-Org-Code`、`X-Client-Platform/Version`、`X-Iam-Confirm`、
`X-Raccoon-Version` 全部无效，错误码结构性一致）。

### 确认的手段就是「做一次 refresh」

拿 `access_token` 当 `refresh_token` 提交：

```
POST /api/web/auth/v1/refresh   {"refresh_token": <access_token>}
→ 200 {"code":0,"data":{"access_token":"…","refresh_token":"…"}}
```

服务端会补发**完整的 access+refresh 令牌对**，并把该会话标记为已确认。
确认后**原来那个裸 access_token 也直接可用**（实测：确认前 balance 400，
确认后同一 token balance 200 = 5173 分）。

### 为什么桌面客户端从不报这个错

客户端本地 auth.json 里 `refresh_token === access_token`，且客户端自己走过
refresh 完成确认 —— 所以 Olivia 从来没出现过 200901。

## 三、修复

`src/raccoon/auth.js` 的 `pollLoginSession()` success 分支：

```js
// 新 IAM 扫码 success 不回 refresh_token → 立即自换一次 refresh 完成确认
if (refreshToken.length === 0) {
  const rr = await client.request({
    method: 'POST', path: 'refresh',
    headers: { ...LOGIN_HEADERS },
    body: { refresh_token: accessToken },
  });
  // 用换回的 access+refresh 替换落库凭据
}
```

这一处改动同时修掉两个连带故障：

1. `refreshToken` 为 null → 账号**不可续期**（30 天后必然掉线且无法自动恢复）；
2. `fetchUserInfo` 被 200901 打成空对象且**静默吞掉** → 落库的 `userId` / `raccoonOrg`
   全空、label 退化成 `raccoon`，多账号无法区分。

确认之后再调 `user_info` 就能拿到 `id` / `phone` / `office_identity`，
label 正确拼成 `RaccoonAnthony-3389`。

### 回归测试

`src/test/raccoon.test.js` 新增用例：
「扫码 success 无 refresh_token 时必须自动 refresh 补全（修 iam_confirm_required）」
—— mock 上游只回 `access_token`，断言：恰好发一次 refresh、提交的是 access_token、
落库的是 refresh 换回的完整令牌对（不是原始裸 access）。

## 四、修复后的实测结果

| 账号 | userId | label | 每日积分余额 | 作废总量 | 最早到期 |
|---|---|---|---|---|---|
| Anthony | 7651374 | RaccoonAnthony-3389 | 300 | 0 | 2026-10-21（7 天） |
| Olivia | 7651371 | RaccoonOlivia-3389 | 600 | 600 | 2026-10-20 |

两个账号 balance / bills / user_info / daily-usage 全部 200。

## 五、排查中确认的其它事实

- `/api/iam/v1/account` 是**有效端点**（新信封 `{code:"OK",message,request_id,data}`），
  返回 user 的 `platform_user_id` / `phone`（脱敏）/ `wechat_bound` / `last_login_at`。
  可作诊断用；`/api/iam/v1/me|user|profile|auth/me|auth/session` 均 404。
- 解包产物里**完全没有** `200901` / `iam_confirm_required` 字样 —— 客户端从不
  直接调 `/api/iam/v1`（它只走 `/api/web/*`），这个码纯粹是服务端网关行为。
- 官方客户端认证模块在 `desktop-renderer/_next/static/chunks/75741-*.js`：
  扫码走 `login_with_qrcode_code`，另有 `login_with_password` / `login_with_sms`。
- `/api/web/auth/v1/login_with_qrcode_code` 对**新签发的** `qr-<uuid>` 码返回
  `pending`（不报错），说明新码在旧端点侧是被识别的；但兑换必须走新 IAM 轮询。
