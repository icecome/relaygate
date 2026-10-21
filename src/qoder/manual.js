'use strict';
/**
 * qoder/manual.js — 手动导入 Qoder 凭据（跨机 / 无桌面客户端场景）。
 *
 * 为什么需要它：本机导入（qoder/local.js）要求服务端与桌面客户端跑在同一台
 * Windows 上——凭据是 Chromium os_crypt v10 + DPAPI 密文，换个用户/机器就
 * 解不开。服务端部署在 Linux、或想给另一台机器上的账号接入时，本机扫描这条路
 * 走不通，而 Qoder 上游只认 `dt-` access token（纯 Bearer），凭据本身是**可移植**的：
 * 用户在客户端机器上取出 token，粘贴进来即可。
 *
 * 与 WorkBuddy 的跨机粘贴（routes/workbuddy.js 的 infoJsonText）差异：
 * WorkBuddy 的 .info 粘贴**不做在线验证**，导入后必须补验；Qoder 这里做验证，
 * 因为运营面有 `GET /api/v1/userinfo` 这个零副作用的身份端点，一次请求就能
 * 确认 token 有效并拿到 uid / 昵称 / 邮箱——不验证就会把无效 token 静默入库，
 * 而它在第一次领积分时才失败（30 天后才有人发现）。
 *
 * realm（国内版 / 国际版）**必须由用户显式指定**：
 *   - 两个区域是完全独立的账号体系（uid 不同、域名不同），token 不能混用；
 *   - 国际版客户端的 fastEndpoint 实测指向 api6.qoder.com.cn（一个 .com.cn
 *     域名），所以绝不能像 zcode 那样「按域名猜」——那会把国际版误判成国内版
 *     （这条约束见 qoder/local.js 与 variant.js 的 qoderRealmOfAccount 注释）。
 *   未指定时归 intl（variant.qoderRealm 的既有口径：运营面双区域同构）。
 *
 * 安全边界：token 只从管理面请求体进入，写入前经 store 的列级加密；
 * 响应一律脱敏（与 routes/qoder.js 的 redact 同一口径）。
 */
const store = require('../credentials/store');
const variant = require('../platform/variant');
const { QoderApiError, QoderRegionError } = require('./client');

/** 账号入库标签前缀（与本机导入的 qoder-<realm>-<uid> 区分，便于区分来源）。 */
const LABEL_PREFIX = 'qoder-manual';

/**
 * 解析粘贴的凭据文本。
 *
 * 接受三种形态（按用户手上实际有的东西设计）：
 *   1. 裸 token：`dt-...`（`Bearer ` 前缀与首尾空白会被剥掉）
 *   2. 凭据 JSON 文本：auth.v1.dat 解密后的结构 { token, refreshToken, expiresAt,
 *      refreshTokenExpiresAt, user:{id,name,email} }，或 deviceToken/poll 的响应
 *      { token, user_id, expiresAt }（字段名差异由 normalizeAuth 兼容）
 *   3. JSON 对象（脚本/测试直传，不必先 stringify）
 *
 * @param {string} text 用户粘贴的原文
 * @returns {{token:string, refreshToken:string|null, expiresAt:string|null,
 *            refreshExpiresAt:string|null, userId:string|null,
 *            userName:string|null, userEmail:string|null}}
 */
function parseCredential(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) {
    const e = new Error('请粘贴 Qoder 凭据（dt- 开头的 token，或客户端凭据 JSON）');
    e.status = 400;
    throw e;
  }

  let data;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      const err = new Error(`粘贴内容不是合法 JSON：${e.message}`);
      err.status = 400;
      throw err;
    }
    if (Array.isArray(data)) {
      const err = new Error('粘贴的 JSON 必须是单个凭据对象，不能是数组（批量导入请逐条粘贴）');
      err.status = 400;
      throw err;
    }
    if (!data || typeof data !== 'object') {
      const err = new Error('粘贴的 JSON 必须是凭据对象');
      err.status = 400;
      throw err;
    }
  } else {
    // 裸 token：容忍 `Bearer dt-...` 与空白
    data = { token: raw.replace(/^Bearer\s+/i, '') };
  }

  // 复用 crypto.normalizeAuth 的字段兼容逻辑（token/accessToken/access_token、
  // user.id、refreshToken/refresh_token 等），保证与桌面端导入同一口径。
  const { normalizeAuth } = require('./crypto');
  let norm;
  try {
    norm = normalizeAuth(data);
  } catch (e) {
    const err = new Error(e.message);
    err.status = 400;
    throw err;
  }
  if (!/^dt-/.test(norm.token)) {
    const err = new Error(`token 形态不符：Qoder 的 access token 以 "dt-" 开头（实际 ${JSON.stringify(norm.token.slice(0, 6))}…）`);
    err.status = 400;
    throw err;
  }
  return norm;
}

/**
 * 在线验证 token 并取回身份（uid / 昵称 / 邮箱）。
 *
 * 用 userinfo 而不是 campaigns/quota：它是纯读、双区域同构、且不依赖活动平台
 * 是否开放。`expiresAt` 若粘贴内容里没有，保留 null（保活列按「长期有效」展示，
 * 与 ZCode 的 JWT 同口径，不会误报「已过期」）。
 *
 * @returns {Promise<{ok:boolean, userId:string|null, userName:string|null,
 *                    userEmail:string|null, status:number|null, reason?:string}>}
 */
async function verifyToken(realm, token) {
  try {
    const j = await require('./client').request({
      method: 'GET',
      path: 'userinfo',
      token,
      realm,
    });
    return {
      ok: true,
      status: 200,
      userId: j && j.id != null ? String(j.id) : null,
      userName: j && j.name != null ? String(j.name) : null,
      userEmail: j && j.email != null ? String(j.email) : null,
    };
  } catch (e) {
    return {
      ok: false,
      status: e instanceof QoderApiError || e instanceof QoderRegionError ? e.status : null,
      userId: null,
      userName: null,
      userEmail: null,
      reason: e.message,
    };
  }
}

/**
 * 手动导入一个 Qoder 账号（验证 → 入库，幂等）。
 *
 * 幂等键与本机导入一致：`realm + userId`。同一区域的同一账号重复粘贴只更新凭据，
 * 不产生重复记录——否则用户换一次 token 就多一条账号，领取任务会对同一账号跑两遍。
 *
 * @param {object} input
 * @param {string} input.realm        'cn' | 'intl'（缺省 intl）
 * @param {string} input.credential   粘贴的 token 或凭据 JSON
 * @param {string} [input.label]      备注名
 * @param {boolean} [input.verify]    是否在线验证（默认 true）
 * @returns {Promise<{ok:boolean, action:'created'|'updated', account:object, verified:boolean, message?:string}>}
 */
async function importManual(input = {}) {
  const realm = variant.qoderRealm(input.realm);
  const cred = parseCredential(input.credential);
  const cfg = variant.qoderRealmConfig(realm);

  const doVerify = input.verify !== false;
  let verified = false;
  let identity = { userId: cred.userId, userName: cred.userName, userEmail: cred.userEmail };
  if (doVerify) {
    const v = await verifyToken(realm, cred.token);
    if (!v.ok) {
      // 401/403 = token 无效或不属于该区域（用户选错 realm 的典型表现）→ 400，
      // 让前端能直接呈现「请确认区域选对了吗」；其余（网络/区域不可用）→ 502。
      const status = v.status === 401 || v.status === 403 ? 400 : 502;
      const hint = status === 400 ? '。请确认 token 属于所选区域且未过期' : '（上游暂不可达，可传 verify:false 跳过验证）';
      const err = new Error(`凭据验证失败（${cfg.openapi}）：${v.reason}${hint}`);
      err.status = status;
      throw err;
    }
    verified = true;
    identity = { userId: v.userId || cred.userId, userName: v.userName || cred.userName, userEmail: v.userEmail || cred.userEmail };
  }

  const userId = identity.userId || null;
  // 默认标签：昵称 → 邮箱 → token 尾段。用 token 尾段（而非全量）是为了不把
  // 完整凭据写进可导出的账号标签里；realm 必须带上，否则两个区域的同尾段账号
  // 在面板上会分不清。
  const fallbackLabel = `${LABEL_PREFIX}-${realm}-${cred.token.replace(/^dt-/, '').slice(-6).replace(/[-_]+$/, '')}`;
  const label = String(input.label || '').trim()
    || identity.userName
    || identity.userEmail
    || fallbackLabel;

  const patch = {
    label,
    edition: variant.QODER,
    mode: 'device',
    qoderRealm: realm,
    token: cred.token,
    refreshToken: cred.refreshToken,
    expiredAt: cred.expiresAt,
    refreshExpiredAt: cred.refreshExpiresAt,
    userId,
    userName: identity.userName,
    userEmail: identity.userEmail,
    host: cfg.openapi,
    source: 'manual',
  };

  const existing = findExisting(realm, userId, cred.token);

  // 手动导入不擅自改 enabled：账号可能正被用户停用（例如不想再领积分），
  // 覆盖回去会让「停用」这个决定静默失效。新建时才默认启用（store.add 的默认）。
  const saved = existing
    ? store.update(existing.id, { ...patch, lastCheckinResult: 'manual_import_updated' })
    : store.add(patch, 'manual');
  const action = existing ? 'updated' : 'created';

  return {
    ok: true,
    action,
    verified,
    account: redactAccount(saved, !!cred.token),
    message: `${action === 'created' ? '已导入' : '已更新'} Qoder ${realm === 'cn' ? '国内版' : '国际版'}账号：${saved.label}`,
  };
}

/**
 * 找同账号的既有记录（幂等键），三级回退：
 *   1. realm + userId —— 与本机导入同一口径（最可靠）
 *   2. realm + host + 相同 token —— `verify:false` 且粘贴内容里没有 user 时
 *      userId 为空，此时只能按「同一区域的同一条 token」认定是同一账号。
 *      这正是用户重复粘贴同一个 token 的场景，若不做这层回退，每导一次就多
 *      一条账号，领取任务会对同一账号跑两遍。
 *   3. 都没有 → 新建
 *
 * 刻意**不**用 label 匹配：标签是用户可编辑的展示字段，拿它当身份键会误合并。
 */
function findExisting(realm, userId, token) {
  const list = store.list();
  if (userId) {
    const byUid = list.find((a) => variant.isEdition(a.edition, variant.QODER)
      && variant.qoderRealmOfAccount(a) === realm
      && a.userId && String(a.userId) === String(userId));
    if (byUid) return byUid;
  }
  if (!token) return null;
  // store.list() 是脱敏的（无 token 明文），比对须走 get()。
  for (const a of list) {
    if (!variant.isEdition(a.edition, variant.QODER)) continue;
    if (variant.qoderRealmOfAccount(a) !== realm) continue;
    const full = store.get(a.id);
    if (full && String(full.token || '') === String(token)) return full;
  }
  return null;
}

/**
 * 出参脱敏（与 routes/qoder.js 的 redact 同口径：token 不出网）。
 *
 * `store.add` / `store.update` 返回的就是 safeTok 之后的账号（token/refreshToken
 * 已被剥掉），所以这里不能再从入参里读 token 判断有没有凭据——那会恒为 false。
 * 有无 token 由调用方按「本次写进去的凭据」显式传入。
 */
function redactAccount(acct, hasCred = false) {
  const { token, refreshToken, apiKey, ...rest } = acct || {};
  return {
    ...rest,
    realm: variant.qoderRealmOfAccount(acct),
    hasToken: hasCred,
    hasRefreshToken: hasCred,
  };
}

module.exports = {
  LABEL_PREFIX,
  parseCredential,
  verifyToken,
  importManual,
};
