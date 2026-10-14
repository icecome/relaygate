'use strict';
/**
 * qoder/local.js — 从本机 Qoder 桌面客户端凭据导入账号（双区域）。
 *
 * 客户端（国际版 / 国内版）都把凭据写在 `%APPDATA%\<appDir>\auth.v1.dat`，
 * 加密链路完全同构（Chromium os_crypt v10 + DPAPI，见 qoder/crypto.js）。
 * 两个区域是**不同的账号体系**（uid 不同），因此 realm 必须随账号持久化：
 * 域名选择、对话协议（新版 OpenAI vs COSY）、模型目录获取方式三者都依赖它。
 *
 * realm 判定（关键，勿改成按域名后缀猜）：
 *   由「扫到哪个客户端目录」确定。国际版客户端的 endpoint 缓存里
 *   fastEndpoint 实测指向 api6.qoder.com.cn（一个 .com.cn 域名），
 *   靠 host 后缀判断会把国际版误判成国内版。
 *
 * 三种凭据形态（官方客户端 / CLI）：
 *   1. 桌面端（本模块主路径）：auth.v1.dat，os_crypt v10 + DPAPI
 *   2. CLI：~/.qoder/.auth/user，AES-128-CBC，key=iv=machine_id 前 16 字节
 *      —— 本期不扫：CLI 凭据的 machine_id 不在客户端目录内，且桌面端优先
 *   3. PAT（pt- 前缀）：由用户在网页端生成，走手工导入而非本机扫描
 *
 * 与 zcode/local.js 的差异：Qoder 有 realm 分叉，且 token 是 dt-/drt- 族
 * （OAuth device flow），不是 JWT——没有 user_id 字段，userId 取自 user.id。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('./crypto');
const variant = require('../platform/variant');
const { QoderCryptoError } = crypto;

/** 单个 realm 的客户端探测结果。 */
function probeRealm(realm) {
  const cfg = variant.qoderRealmConfig(realm);
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const appDir = path.join(roaming, cfg.appDir);
  const envOverride = String(process.env[`QODER_${realm.toUpperCase()}_APP_DIR`] || '').trim();
  const dir = envOverride || appDir;
  const out = {
    realm,
    appDir: dir,
    installed: fs.existsSync(path.join(dir, 'auth.v1.dat')),
    // 客户端版本（home 下 .qoder-app-status.json，仅供展示）
    clientVersion: null,
    loggedIn: null,
  };
  if (!out.installed) return out;

  // 客户端自己写的登录态快照（含版本与账号名），能读则读，读不到不影响凭据解密
  try {
    const home = path.join(os.homedir(), cfg.homeDir, '.qoder-app-status.json');
    if (fs.existsSync(home)) {
      const st = JSON.parse(fs.readFileSync(home, 'utf8'));
      out.clientVersion = st.version || null;
      out.loggedIn = st.logged_in != null ? !!st.logged_in : null;
    }
  } catch { /* 快照损坏不影响凭据导入 */ }

  try {
    out.credentials = crypto.readCredentials(dir);
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/** 探测两个区域的客户端安装与登录情况。 */
function probeAll() {
  return {
    cn: probeRealm('cn'),
    intl: probeRealm('intl'),
    windows: crypto.isWindows(),
  };
}

/** 是否至少有一个区域的客户端已登录。 */
function isClientInstalled() {
  return probeAll().cn.installed || probeAll().intl.installed;
}

/** 指定 realm 的客户端目录（供面板展示）。 */
function appDirOf(realm) {
  return variant.qoderRealmConfig(realm)
    ? (process.env[`QODER_${realm.toUpperCase()}_APP_DIR`] || '').trim()
      || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        variant.qoderRealmConfig(realm).appDir)
    : null;
}

/** 指定 realm 的凭据（未归一化则抛错）。 */
function readRealmCredentials(realm) {
  const p = probeRealm(realm);
  if (!p.installed) {
    throw new QoderCryptoError(`未安装 Qoder ${variant.qoderRealmConfig(realm).label} 客户端（${p.appDir}）`);
  }
  if (p.error) throw new QoderCryptoError(p.error);
  return p.credentials;
}

/**
 * 构造 store 账号记录（未入库）。
 *
 * mode 固定 'device'（dt-/drt- OAuth device flow 凭据）；
 * host 留空——Qoder 的域名按 realm 从 variant 取，不存进 host 列
 * （host 列在既有平台里是「该账号实际使用的上游域」，Qoder 运营面域名固定）。
 *
 * @param {string} realm 'cn' | 'intl'
 * @param {object} [opts]
 * @param {boolean} [opts.requireRealm] realm 缺失时是否报错（批量导入用）
 */
function buildAccountFromLocal(realm, opts = {}) {
  const r = variant.qoderRealm(realm);
  const cred = readRealmCredentials(r);
  const cfg = variant.qoderRealmConfig(r);
  const label = `qoder-${r}-${cred.userId || 'local'}`;
  return {
    label,
    edition: variant.QODER,
    mode: 'device',
    qoderRealm: r,
    token: cred.token,
    refreshToken: cred.refreshToken,
    expiredAt: cred.expiresAt,
    refreshExpiredAt: cred.refreshExpiresAt,
    userId: cred.userId,
    userName: cred.userName,
    userEmail: cred.userEmail,
    host: cfg.openapi,
    source: 'local',
  };
}

/**
 * 导入本机已登录的全部区域账号（幂等：同 realm+userId 更新而非重复插入）。
 * @returns {{created:Array, updated:Array, skipped:Array}}
 */
function importAllLocal() {
  const store = require('../credentials/store');
  const out = { created: [], updated: [], skipped: [] };
  for (const realm of ['cn', 'intl']) {
    let acct;
    try {
      acct = buildAccountFromLocal(realm);
    } catch (e) {
      out.skipped.push({ realm, reason: e.message });
      continue;
    }
    const existing = store.list().find((a) => variant.isEdition(a.edition, variant.QODER)
      && variant.qoderRealmOfAccount(a) === realm
      && a.userId && acct.userId && String(a.userId) === String(acct.userId));
    if (existing) {
      const updated = store.update(existing.id, {
        ...acct,
        lastCheckinResult: 'local_import_updated',
      });
      out.updated.push({ realm, id: updated.id, label: updated.label });
    } else {
      const created = store.add(acct, 'local');
      out.created.push({ realm, id: created.id, label: created.label });
    }
  }
  return out;
}

module.exports = {
  probeRealm,
  probeAll,
  isClientInstalled,
  appDirOf,
  readRealmCredentials,
  buildAccountFromLocal,
  importAllLocal,
};
