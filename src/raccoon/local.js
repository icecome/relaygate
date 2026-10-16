'use strict';
/**
 * raccoon/local.js —— 从**本机小浣熊桌面客户端**导入已登录账号。
 *
 * ## 为什么这条链路值得做（2026-10-15 解包实证）
 *
 * 本网关此前的 Raccoon 登录只有「面板承载扫码」一条路（见 docs/raccoon-integration.md
 * 开头「本机没有官方桌面客户端可读凭据」的论断）。那个论断在客户端装上之后**被推翻**：
 * 桌面端把凭据**明文**写在磁盘上，可直接读取，与 ZCode（AES-256-GCM）/
 * Qoder（Chromium os_crypt + DPAPI）都要解密不同 —— Raccoon 零解密成本。
 *
 * 凭据文件（客户端 `build/electron/main/boxAgentAuthFile.js` 实证）：
 *
 *   路径   = $BOX_AGENT_CONFIG_DIR || ~/.box-agent/config ，其下 auth.json
 *   字段   = { access_token, refresh_token, office_identity,
 *              office_org_name?, office_org_role? }
 *   写入   = 0600 + 临时文件 rename（原子）；**明文 JSON，不加密**
 *
 * ⚠️ 路径判据必须与客户端同源（`BOX_AGENT_CONFIG_DIR` 环境变量优先），
 * 否则用户改过配置目录时会读错地方。
 *
 * ## 三个实测口径（别按直觉改）
 *
 * 1. **`refresh_token` 与 `access_token` 完全相同**。客户端就是这么写的
 *    （见 `desktopLogin.js` 的 exchange 结果落库），不是本模块读错。
 *    所以续期拿它去 POST `/api/web/auth/v1/refresh` 是对的（实测可用）。
 * 2. **`office_identity` 的字面值是 `"personal"`**（个人账号），
 *    而 `user_info` 里的同名字段是**空串** —— 两个来源语义不同。
 *    `"personal"` 绝不能进 `X-Org-Code`（会 400 org_not_found_error，
 *    见 `product.orgCodeOf`）。本模块入库前用 `orgCodeOf` 归一，让脏值
 *    不会在账号库里扩散。
 * 3. **`auth.json` 里没有过期时间**。access_token 是 JWT，
 *    过期时刻只能从 `exp` 解（实测寿命 30 天，不是文档早先记载的 3 小时）。
 *
 * ## 设备标识
 *
 * 客户端另有 `desktop-device-identity.json`（`clientDeviceId` = randomUUID），
 * 但解包实证：它只用于 mobile-relay / 设备配对 / skill 投稿这几条链路，
 * **业务 API（points / llm / desktop grant）全链路不发 `X-Client-Device-ID`**。
 * 故本模块刻意不导入它 —— 发一个上游没在收的头没有收益，只有指纹风险。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const product = require('./product');

/** 客户端凭据文件路径（与客户端 getBoxAgentAuthPath() 同源）。 */
function credentialsPath() {
  const dir = String(process.env.BOX_AGENT_CONFIG_DIR || '').trim()
    || path.join(os.homedir(), '.box-agent', 'config');
  return path.join(dir, 'auth.json');
}

/** 客户端数据目录（仅供面板展示「从哪读的」）。 */
function clientDataDir() {
  return path.dirname(credentialsPath());
}

/**
 * 本机客户端是否装了**并登录过**（凭据文件存在且含 access_token）。
 * 只 stat 文件不做完整校验 —— 与 zcode/qoder 的 isClientInstalled 同语义。
 */
function isClientInstalled() {
  return fs.existsSync(credentialsPath());
}

/**
 * 读取本机客户端凭据，返回**上游凭据形状**。
 *
 * @returns {{access_token:string, refresh_token:string, office_identity?:string, expires_at?:string}}
 * @throws 文件缺失 / 缺 access_token 时抛错（调用方负责转成用户可读文案）
 */
function readLocalCredential() {
  const file = credentialsPath();
  if (!fs.existsSync(file)) {
    throw new Error(`未找到小浣熊客户端凭据：${file}（请确认已安装桌面端并登录过）`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`客户端凭据解析失败：${file}（${e.message}）`);
  }
  // 客户端的读取器接受三个别名（access_token | token | auth_token），
  // 这里同样三者都收：客户端版本演进时不必回来改。
  const accessToken = pickString(raw.access_token ?? raw.token ?? raw.auth_token);
  if (!accessToken) {
    throw new Error(`客户端凭据里没有 access_token：${file}（客户端可能已退出登录）`);
  }
  const refreshToken = pickString(raw.refresh_token);
  const credential = {
    access_token: accessToken,
    refresh_token: refreshToken,
    // 归一化后入库：personal → ''（见文件头口径 2）
    office_identity: product.orgCodeOf({ office_identity: pickString(raw.office_identity) }),
  };
  // auth.json 不带过期时间，从 JWT 的 exp 解出毫秒时间戳
  const expMs = product.decodeJwtExpMs(accessToken);
  if (expMs !== undefined) credential.expires_at = String(expMs);
  return credential;
}

function pickString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * 探测本机安装情况（面板预检用，**不抛错**）。
 *
 * 与 routes/zcode.js 的 /local/preview 同构：只回答「能不能导」与「导的是谁」，
 * 失败原因放进 error 字段而不是抛出 —— 面板要在没装客户端时正常渲染这一张卡。
 */
function preview() {
  const out = {
    installed: isClientInstalled(),
    path: clientDataDir(),
    credentialFile: credentialsPath(),
    userId: null,
    hasRefreshToken: false,
    expiresAt: null,
    officeIdentity: null,
    error: null,
  };
  if (!out.installed) return out;
  try {
    const c = readLocalCredential();
    out.hasRefreshToken = c.refresh_token.length > 0;
    out.expiresAt = c.expires_at ? new Date(Number(c.expires_at)).toISOString() : null;
    out.officeIdentity = c.office_identity || '';
    // userId 只能从 JWT 的 sub 拿到（形如 pu-xxxx）。它**不是** user_info.id
    // （数字，如 7651374），两者是不同标识体系，故只作展示，不参与幂等匹配。
    const sub = jwtClaim(c.access_token, 'sub');
    out.userId = sub;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/** 取 JWT 的某个声明（不验签，仅展示用）。 */
function jwtClaim(token, claim) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const v = payload && payload[claim];
    return v != null && String(v).trim() ? String(v).trim() : null;
  } catch {
    return null;
  }
}

/**
 * 导入本机客户端凭据（幂等）。
 *
 * 落库**复用 auth.persistLogin**，不另写一套：这样导入的账号与扫码登录的账号
 * 走完全相同的 label 规则、userId 判据与过期时间口径，两个入口不会产出重复账号。
 * persistLogin 内部会拉 user_info（需要网络）—— 拿不到真实 userId 时它会以
 * `raccoon-<sub?>` 之类的降级 label 入库，因此这里先校验凭据可用（未过期），
 * 避免把一个已经过期的本地凭据静默导入成「可用账号」。
 *
 * @returns {Promise<object>} 入库后的账号记录
 */
async function importFromLocal() {
  const credential = readLocalCredential();
  if (product.isExpired(credential)) {
    const exp = credential.expires_at ? new Date(Number(credential.expires_at)).toISOString() : '未知';
    throw new Error(`本机客户端凭据已过期（${exp}）。请在小浣熊桌面端重新登录后再导入。`);
  }
  const auth = require('./auth');
  return auth.persistLogin(credential);
}

module.exports = {
  credentialsPath,
  clientDataDir,
  isClientInstalled,
  readLocalCredential,
  preview,
  importFromLocal,
  jwtClaim,
};
