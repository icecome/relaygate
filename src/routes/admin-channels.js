'use strict';
/**
 * routes/admin-channels.js —— 渠道接入聚合端点。
 * 挂载前缀：/v1/admin（见 index.js）。全部走管理鉴权。
 *
 * 为什么需要它（m-40）：前端「接入新账号」此前是「每加一个平台手写一个弹窗」。
 * ZCode 的后端接口（/v1/zcode/local/preview + /local/import + /rewards/*）全部
 * 就绪，前端却连一个按钮都没有——账号根本接不进来，只能手工打 API。
 * 平台能力位本来就在 platform/variant.js（单一事实源），前端另维护一份必然漂移。
 *
 * 本端点把三件事一次性摊平，前端只负责渲染：
 *   1. 渠道身份与能力位——直接读 variant.js，不复制、不硬编码平台名单；
 *   2. 真实账号计数——accounts 表按 edition 过滤（与凭据列表同一数据源）；
 *   3. 每条接入方式在本机是否真的可用——本机客户端探测。
 * 于是「漏加入口」不再是空白页面，而是渠道卡片上明确显示的「待接入」+ 原因。
 *
 * 探测全部是本地磁盘读取，不发起任何网络请求，可被面板安全轮询。
 * 单平台探测异常降级为「不可用 + 原因」，不让一个平台的异常挡住另外三个。
 */
const { Router } = require('express');
const store = require('../credentials/store');
const variant = require('../platform/variant');
const wbAuth = require('../workbuddy/auth');
const zcodeLocal = require('../zcode/local');
const qoderLocal = require('../qoder/local');
const raccoonLocal = require('../raccoon/local');
const { authenticateAdmin } = require('../middleware/auth');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

/** 各平台「粘贴导入」时用户手上究竟该有什么东西（文案随平台不同）。 */
const PASTE_HINT = {
  [variant.TRAE]: '粘贴 Trae 客户端存储中的凭据 JSON（含 refreshToken）',
  [variant.WORKBUDDY]: '粘贴 workbuddy-desktop.info 的**明文**内容（需先按 docs/workbuddy-at-rest-crypto.md 解密 envelope）；跨机导入后需补验登录',
  // Qoder 的粘贴是真的可移植凭据：上游只认纯 Bearer 的 dt- token。
  // 这与 ZCode 形成对照——ZCode 的 JWT 由「平台+家目录+用户名」派生、
  // 上游不发放可移植凭据，所以它没有这条入口（见 variant.js 的 onboarding）。
  [variant.QODER]: '粘贴 dt- access token 或客户端凭据 JSON，需选择国内版 / 国际版；导入时在线验证',
};

/**
 * 按平台统计账号数。
 *
 * store.list() 只调用一次再分组，避免四个平台各查一遍库。
 * 归一用 variantOf：它把历史 edition（cn/sg/us/manual/wb*）折回平台，
 * 与前端 shared/lib/format.ts#platformOf 是同一套规则。
 */
function accountsByPlatform() {
  const out = {};
  for (const v of variant.allVariants()) out[v.id] = { total: 0, enabled: 0, cooling: 0 };
  const now = Date.now();
  for (const a of store.list()) {
    const bucket = out[variant.variantOf(a.edition).id];
    if (!bucket) continue;
    bucket.total += 1;
    if (a.enabled) bucket.enabled += 1;
    if (a.coolUntil && new Date(a.coolUntil).getTime() > now) bucket.cooling += 1;
  }
  return out;
}

/**
 * 本机客户端探测（各平台实现不同）。
 * 返回 { available, detail } ，qoder 额外带 realms（双区域各自可导性）。
 */
function localProbe(platformId) {
  if (platformId === variant.WORKBUDDY) {
    const info = wbAuth.readAuthFile();
    if (info) {
      return {
        available: true,
        detail: `本机登录态：${info.nickname || info.uid || '已登录'}`,
      };
    }
    // readAuthFile() 返回 null 有两种原因，必须分开：客户端没登录（用户去登录就行），
    // 与客户端已登录但凭据已加密（2026-09-24 起，去登录也没用，必须走粘贴导入）。
    // 混成一句「未找到登录态」会让用户反复登录、反复撞墙——这是实测踩过的坑。
    const dir = variant.clientAuthDir(variant.WORKBUDDY);
    let encrypted = false;
    try {
      const fs = require('fs');
      const path = require('path');
      if (dir && fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (!f.startsWith('workbuddy-desktop') || !f.endsWith('.info')) continue;
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (j && j.auth && j.auth.accessToken && typeof j.auth.accessToken === 'object') {
            encrypted = true;
            break;
          }
        }
      }
    } catch { /* 探测失败按未登录处理，不阻断其余平台 */ }
    return {
      available: false,
      detail: encrypted
        ? '客户端已登录但凭据已加密（2026-09-24 起客户端把 token 写成 $wbEncrypted 对象，'
          + '密钥由客户端进程持有、离线无法解密）。请改用「粘贴凭据导入」，'
          + '并先按 docs/workbuddy-at-rest-crypto.md 解出明文 JWT。'
        : '未找到本机登录态，需先安装并登录 CodeBuddy / WorkBuddy 桌面端',
    };
  }
  if (platformId === variant.ZCODE) {
    const installed = zcodeLocal.isClientInstalled();
    const p = zcodeLocal.credentialsPath();
    return {
      available: installed,
      detail: installed ? p : `未找到凭据文件 ${p}，需先安装并登录 ZCode 桌面端`,
    };
  }
  if (platformId === variant.QODER) {
    const probe = qoderLocal.probeAll();
    const realms = ['cn', 'intl'].map((realm) => {
      const p = probe[realm] || {};
      return {
        realm,
        installed: !!p.installed,
        loggedIn: !!p.loggedIn,
        available: !!(p.installed && p.loggedIn),
        detail: p.error
          || (p.installed ? (p.loggedIn ? '已登录，可导入' : '已安装但未登录') : '未检测到客户端'),
      };
    });
    const any = realms.some((r) => r.available);
    return {
      available: any,
      detail: any ? '可导入已登录区域' : '未检测到已登录的 Qoder 客户端（国内版 / 国际版）',
      windows: !!probe.windows,
      realms,
    };
  }
  if (platformId === variant.RACCOON) {
    // 小浣熊桌面端把凭据**明文**写在 ~/.box-agent/config/auth.json；
    // 这里只回答「有没有、在哪」，不读取 token 内容（面板不需要）。
    const installed = raccoonLocal.isClientInstalled();
    const p = raccoonLocal.credentialsPath();
    return {
      available: installed,
      detail: installed
        ? `本机登录态：${p}`
        : `未找到凭据文件 ${p}，需先安装并登录商汤小浣熊桌面端`,
    };
  }
  return { available: false, detail: '该平台未实现本机客户端导入' };
}

/** 逐条接入方式的可用性；探测异常降级为不可用，绝不 500。 */
function onboardingFor(v) {
  const kinds = Array.isArray(v.onboarding) ? v.onboarding : [];
  return kinds.map((kind) => {
    try {
      if (kind === 'oauth') return { kind, label: 'OAuth 登录', available: true, detail: '' };
      if (kind === 'paste') {
        return { kind, label: '粘贴凭据导入', available: true, detail: PASTE_HINT[v.id] || '' };
      }
      if (kind === 'local') return { kind, label: '读取本机客户端', ...localProbe(v.id) };
      // 「面板承载登录」：不需要本机装任何客户端，也就不存在探测失败，
      // 但必须始终可用 —— 若返回 available:false，卡片上的接入按钮会永久禁用。
      if (kind === 'login') {
        return {
          kind,
          label: '扫码登录',
          available: true,
          detail: '在面板里用微信扫码完成授权（本机无需安装客户端）',
        };
      }
      return { kind, label: kind, available: false, detail: '未识别的接入方式' };
    } catch (e) {
      return { kind, label: kind, available: false, detail: `探测失败：${e.message}` };
    }
  });
}

/**
 * 平台运营面定时任务快照（仅 ZCode / Qoder 有）。
 *
 * 去掉快照里的 localClient：本机探测已由 onboarding 统一给出，
 * 保留两份会在同一响应里出现两个可能不一致的结论。
 */
function jobsFor(platformId) {
  try {
    const snap = platformId === variant.ZCODE
      ? require('../jobs/zcode-rewards').snapshot()
      : platformId === variant.QODER
        ? require('../jobs/qoder-rewards').snapshot()
        : null;
    if (!snap) return null;
    const { localClient, ...rest } = snap;
    return rest;
  } catch {
    return null;
  }
}

/**
 * 渠道清单。
 *
 * connected 的口径是「库里有该平台的账号」（total > 0），**不是** enabled > 0：
 * WorkBuddy 导入后显式 enabled=false，若按 enabled 判定，刚导入完的渠道
 * 会被显示成「待接入」，与用户刚做完的操作直接矛盾。
 */
router.get('/channels', admin, (_req, res) => {
  const counts = accountsByPlatform();
  const data = variant.allVariants().map((v) => ({
    id: v.id,
    label: v.label,
    note: v.note || '',
    capability: v.capability,
    accounts: counts[v.id] || { total: 0, enabled: 0, cooling: 0 },
    onboarding: onboardingFor(v),
    jobs: jobsFor(v.id),
  }));
  res.json({
    object: 'channels',
    data,
    summary: {
      channels: data.length,
      connected: data.filter((c) => c.accounts.total > 0).length,
      accounts: data.reduce((s, c) => s + c.accounts.total, 0),
      enabled: data.reduce((s, c) => s + c.accounts.enabled, 0),
    },
  });
});

module.exports = router;
